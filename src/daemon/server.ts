import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { promisify } from "node:util";

import { loadConfig } from "#src/config/loader.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { checkPortPreflight } from "#src/lib/port-preflight.js";
import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import type { ExecInfo } from "#src/lib/service/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import {
  capturePane,
  getWindowName,
  getWindowOption,
  killPane,
  panePid,
  renameWindow,
  selectPane,
  sendCtrlC,
  sendKeys,
  setWindowOption,
} from "#src/lib/tmux.js";

import { daemonHandlers } from "./handlers/daemon.js";
import { sessionHandlers } from "./handlers/session.js";
import type { SessionCreateParams } from "./session.js";
import { Session, sessionId } from "./session.js";

const execFileAsync = promisify(execFile);

interface SessionStore {
  list(): Session[];
  get(id: string): Session | undefined;
  getByProjectDir(dir: string): Session | undefined;
  create(params: {
    configPath: string;
    projectDir: string;
    tmuxSession: string;
    originPane: string;
  }): Promise<Session>;
  destroy(id: string): Promise<void>;
}

class DaemonServer implements SessionStore {
  private server: net.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  public onSessionChange?: (count: number) => void;

  public async start(socketPath: string): Promise<void> {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() !== "") {
              void this.handleLine(line, socket);
            }
          }
        });
        const cleanupSubscriptions = () => {
          for (const session of this.sessions.values()) {
            session.subscribers.delete(socket);
          }
        };
        socket.on("error", cleanupSubscriptions);
        socket.on("close", cleanupSubscriptions);
      });

      this.server.on("error", reject);
      this.server.listen(socketPath, () => {
        resolve();
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  // --- SessionStore ---

  public list(): Session[] {
    return [...this.sessions.values()];
  }

  public get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  public getByProjectDir(dir: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.projectDir === dir) {
        return s;
      }
    }
    return undefined;
  }

  public async create(params: {
    configPath: string;
    projectDir: string;
    tmuxSession: string;
    originPane: string;
  }): Promise<Session> {
    const id = sessionId(params.configPath);

    // If session already exists, return it
    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }

    // Load config
    const config = await loadConfig(params.configPath, params.projectDir);

    // Build pane layout
    const { paneMap, focusPane } = await createLayout(
      params.originPane,
      config.project.layout,
      config.project.services,
      config.groups,
    );
    await selectPane(focusPane);

    // Late-bound ref so storeExecInfo closure can capture session before it's created
    const ref: { session: Session | null } = { session: null };
    const deps = {
      sendKeys,
      sendCtrlC,
      panePid,
      detectPorts,
      capturePane,
      getDescendantPids,
      renameWindow,
      getWindowName,
      getWindowOption,
      setWindowOption,
      exec: async (cmd: string, args: string[], cwd?: string) => {
        await execFileAsync(cmd, args, cwd ? { cwd } : {});
      },
      preflightPorts: checkPortPreflight,
      storeExecInfo: (service: string, info: ExecInfo) => {
        ref.session?.execInfo.set(service, info);
      },
      sessionId: id,
      zapsCommand: process.env.ZAPS_COMMAND ?? "zaps",
    };

    // Create ServiceManager
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const manager = new ServiceManager(config, paneMap, deps, params.tmuxSession);

    const sessionParams: SessionCreateParams = {
      configPath: params.configPath,
      projectDir: params.projectDir,
      config,
      paneMap,
      tmuxSession: params.tmuxSession,
      originPane: params.originPane,
      deps,
    };

    const session = new Session(sessionParams, manager);
    ref.session = session;
    this.sessions.set(id, session);
    this.onSessionChange?.(this.sessions.size);

    // Start services in background — TUI connects and sees them starting
    void session.startAll().catch(() => {
      /* Errors surfaced via stateChange */
    });

    return session;
  }

  public async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    await session.destroy();

    // Kill non-origin, non-TUI panes
    for (const paneId of Object.values(session.paneMap)) {
      if (paneId !== session.originPane && paneId !== session.paneMap["@tui"]) {
        await killPane(paneId).catch(() => {
          /* Best-effort cleanup */
        });
      }
    }

    this.sessions.delete(id);
    this.onSessionChange?.(this.sessions.size);
  }

  // --- Request routing ---

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IpcRequest = { id: "?", method: "" };
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: "?", error: "Invalid JSON" })}\n`);
      return;
    }

    const response = await this.routeRequest(req, socket);
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private async routeRequest(req: IpcRequest, socket: net.Socket): Promise<IpcResponse> {
    // Daemon-level handlers
    const dHandler = daemonHandlers[req.method];
    if (dHandler) {
      try {
        return await dHandler(req, this);
      } catch (error) {
        return ipcErr(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Session-scoped handlers
    const sHandler = sessionHandlers[req.method];
    if (sHandler) {
      if (!req.session) {
        return ipcErr(req.id, `Session required for method: ${req.method}`);
      }
      try {
        return await sHandler(req, this, socket);
      } catch (error) {
        return ipcErr(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Backward compat: bare "ping" → daemon.ping
    if (req.method === "ping") {
      return ipcOk(req.id, "pong");
    }

    return ipcErr(req.id, `Unknown method: ${req.method}`);
  }
}

export { DaemonServer };
export type { SessionStore };
