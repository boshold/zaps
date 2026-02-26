import fs from "node:fs";
import net from "node:net";

import { discoverConfig } from "#src/config/discovery.js";
import { loadConfig } from "#src/config/loader.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { detectPorts, getDescendantPids } from "#src/lib/port.js";
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
import type { SessionCreateParams } from "./session.js";

import { daemonHandlers } from "./handlers/daemon.js";
import { sessionHandlers } from "./handlers/session.js";
import { Session, sessionId } from "./session.js";

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

function ok(id: string, result: unknown): IpcResponse {
  return { id, result };
}

function err(id: string, error: string): IpcResponse {
  return { id, error };
}

class DaemonServer implements SessionStore {
  private server: net.Server | null = null;
  private sessions = new Map<string, Session>();
  onSessionChange?: (count: number) => void;

  async start(socketPath: string): Promise<void> {
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
        socket.on("error", () => {
          // Client disconnected — clean up subscriptions
          for (const session of this.sessions.values()) {
            session.subscribers.delete(socket);
          }
        });
      });

      this.server.on("error", reject);
      this.server.listen(socketPath, () => {
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // --- SessionStore ---

  list(): Session[] {
    return [...this.sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getByProjectDir(dir: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.projectDir === dir) {
        return s;
      }
    }
    return undefined;
  }

  async create(params: {
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
    const configPath = params.configPath || discoverConfig(params.projectDir);
    if (!configPath) {
      throw new Error("No config found");
    }
    const config = await loadConfig(configPath, params.projectDir);

    // Build pane layout
    const { paneMap, focusPane } = await createLayout(
      params.originPane,
      config.project.layout,
      config.project.services,
    );
    await selectPane(focusPane);

    // Build deps
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
    };

    // Create ServiceManager
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const manager = new ServiceManager(config, paneMap, deps, params.tmuxSession);

    const sessionParams: SessionCreateParams = {
      configPath,
      projectDir: params.projectDir,
      config,
      paneMap,
      tmuxSession: params.tmuxSession,
      originPane: params.originPane,
      deps,
    };

    const session = new Session(sessionParams, manager);
    this.sessions.set(id, session);
    this.onSessionChange?.(this.sessions.size);

    // Start services in background — TUI connects and sees them starting
    void session.startAll().catch(() => {
      /* Errors surfaced via stateChange */
    });

    return session;
  }

  async destroy(id: string): Promise<void> {
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
        return err(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Session-scoped handlers
    const sHandler = sessionHandlers[req.method];
    if (sHandler) {
      if (!req.session) {
        return err(req.id, `Session required for method: ${req.method}`);
      }
      try {
        return await sHandler(req, this, socket);
      } catch (error) {
        return err(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Backward compat: bare "ping" → daemon.ping
    if (req.method === "ping") {
      return ok(req.id, "pong");
    }

    return err(req.id, `Unknown method: ${req.method}`);
  }
}

export { DaemonServer };
export type { SessionStore };
