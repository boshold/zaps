import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { createSentra, isIngestPath, sqliteStorage, toNodeListener } from "@bosdev/sentra-core";
import type { LiveEvent, LiveFilter, Sentra, SentraLogger } from "@bosdev/sentra-core";

import { readPortState, sentraDbPath, sentraPortStatePath, writePortState } from "./paths.js";

const HOST = "127.0.0.1";
const RETRY_AFTER_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function toSentraLogger(log: (msg: string) => void): SentraLogger {
  const write = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    log(`sentra ${level}: ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  };
  return {
    debug: () => {
      /* Empty */
    },
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeAllListeners("listening");
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("sentra server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export type SentraHostState = "stopped" | "running" | "unavailable";

export interface SentraHostStatus {
  state: SentraHostState;
  port: number | null;
  dbPath: string;
  reason: string | null;
}

export interface SentraScopeInput {
  project: string;
  session: string;
  service: string;
}

export interface SentraHostDeps {
  createSentra?: typeof createSentra;
  createServer?: typeof http.createServer;
  dbPath?: string;
  portStatePath?: string;
  /** Daemon log line writer. */
  logger?: (msg: string) => void;
  now?: () => number;
}

/** Owns the daemon's single Sentra instance and its loopback ingest listener. */
export class SentraHost {
  private readonly createSentraFn: typeof createSentra;
  private readonly createServerFn: typeof http.createServer;
  private readonly dbPath: string;
  private readonly portStatePath: string;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  private state: SentraHostState = "stopped";
  private port: number | null = null;
  private reason: string | null = null;
  private failedAt: number | null = null;
  private server: Server | null = null;
  private instance: Sentra | null = null;
  private listener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  private starting: Promise<Sentra | null> | null = null;
  private readonly sourceRoots = new Set<string>();
  private readonly unsubscribers = new Set<() => void>();

  public constructor(deps: SentraHostDeps = {}) {
    this.createSentraFn = deps.createSentra ?? createSentra;
    this.createServerFn = deps.createServer ?? http.createServer;
    this.dbPath = deps.dbPath ?? sentraDbPath();
    this.portStatePath = deps.portStatePath ?? sentraPortStatePath();
    this.log =
      deps.logger ??
      (() => {
        /* Empty */
      });
    this.now = deps.now ?? Date.now;
  }

  public get sentra(): Sentra | null {
    return this.instance;
  }

  /** Starts once; concurrent callers share the attempt. `null` while unavailable. */
  public async ensureStarted(): Promise<Sentra | null> {
    if (this.instance) {
      return this.instance;
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.failedAt !== null && this.now() - this.failedAt < RETRY_AFTER_MS) {
      return null;
    }
    this.starting = this.startOnce();
    return this.starting;
  }

  public getDsn(scope: SentraScopeInput): string {
    if (!this.instance) {
      throw new Error("Sentra is not running");
    }
    return this.instance.getDsn(scope);
  }

  /** Remembered across restarts; applied immediately when running. */
  public addSourceRoot(dir: string): void {
    this.sourceRoots.add(dir);
    this.instance?.addSourceRoot(dir);
  }

  /** Tracked so `close()` can drop every listener. */
  public subscribe(filter: LiveFilter, listener: (event: LiveEvent) => void): () => void {
    if (!this.instance) {
      throw new Error("Sentra is not running");
    }
    const unsubscribe = this.instance.subscribe(filter, listener);
    const tracked = () => {
      this.unsubscribers.delete(tracked);
      unsubscribe();
    };
    this.unsubscribers.add(tracked);
    return tracked;
  }

  public status(): SentraHostStatus {
    return { state: this.state, port: this.port, dbPath: this.dbPath, reason: this.reason };
  }

  public async close(): Promise<void> {
    if (this.starting) {
      await this.starting;
    }
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    const { server, instance } = this;
    this.server = null;
    this.instance = null;
    this.listener = null;
    this.state = "stopped";
    this.port = null;
    this.reason = null;
    this.failedAt = null;
    if (server) {
      await closeServer(server);
    }
    if (instance) {
      await instance.close();
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.listener) {
      res.writeHead(503, { "content-type": "text/plain" }).end("sentra starting\n");
      return;
    }
    const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
    if (!isIngestPath(pathname)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    this.listener(req, res);
  }

  private async bind(server: Server): Promise<number> {
    const preferred = readPortState(this.portStatePath);
    if (preferred !== null) {
      try {
        return await listen(server, preferred);
      } catch (error) {
        if (errorCode(error) !== "EADDRINUSE") {
          throw error;
        }
      }
    }
    return listen(server, 0);
  }

  private async startOnce(): Promise<Sentra | null> {
    try {
      return await this.start();
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<Sentra | null> {
    const server = this.createServerFn((req, res) => this.handleRequest(req, res));
    this.server = server;
    try {
      const port = await this.bind(server);
      this.port = port;
      const sentra = await this.createSentraFn({
        storage: sqliteStorage({ path: this.dbPath, driver: "node" }),
        publicUrl: `http://${HOST}:${port}`,
        logger: toSentraLogger(this.log),
      });
      for (const dir of this.sourceRoots) {
        sentra.addSourceRoot(dir);
      }
      this.instance = sentra;
      this.listener = toNodeListener(async (request) => sentra.handle(request));
      this.state = "running";
      this.reason = null;
      this.failedAt = null;
      this.persistPort(port);
      this.log(`sentra listening on ${HOST}:${port} (db ${this.dbPath})`);
      return sentra;
    } catch (error) {
      this.server = null;
      this.port = null;
      this.state = "unavailable";
      this.reason = errorMessage(error);
      this.failedAt = this.now();
      this.log(`sentra unavailable: ${this.reason}`);
      await closeServer(server);
      return null;
    }
  }

  private persistPort(port: number): void {
    try {
      writePortState(port, this.portStatePath);
    } catch (error) {
      this.log(`sentra: cannot write port state: ${errorMessage(error)}`);
    }
  }
}
