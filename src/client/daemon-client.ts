import { EventEmitter } from "node:events";

import type { DockerConfig } from "#src/config/types.js";
import type { SessionSnapshot } from "#src/daemon/session.js";
import type { IpcSubscription } from "#src/lib/ipc/client.js";
import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent, IpcResponse } from "#src/lib/ipc/protocol.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

export interface DaemonClientEvents {
  "service.stateChange": (name: string, status: ServiceStatus) => void;
  "log.lines": (service: string, lines: string[]) => void;
  "task.start": (key: string, name: string) => void;
  "task.complete": (key: string, name: string, result: "success" | "error") => void;
  "session.destroyed": () => void;
  disconnect: () => void;
}

/**
 * High-level client for TUI to communicate with daemon.
 * Subscribes to events and provides methods for all session-scoped operations.
 */
export class DaemonClient extends EventEmitter {
  private socketPath: string;
  private sessionId: string;
  private sub: IpcSubscription | null = null;

  constructor(socketPath: string, sessionId: string) {
    super();
    this.socketPath = socketPath;
    this.sessionId = sessionId;
  }

  connect(): void {
    this.sub = ipcSubscribe(
      this.socketPath,
      this.sessionId,
      ["service.*", "log.*", "task.*", "session.*"],
      (event: DaemonEvent) => {
        this.handleEvent(event);
      },
      () => {
        this.emit("disconnect");
      },
    );
  }

  disconnect(): void {
    if (this.sub) {
      // Send detach before closing
      this.sub.send("session.detach");
      this.sub.close();
      this.sub = null;
    }
  }

  get connected(): boolean {
    return this.sub?.connected ?? false;
  }

  get session(): string {
    return this.sessionId;
  }

  // --- Session operations ---

  async attach(): Promise<SessionSnapshot> {
    const res = await this.request("session.attach");
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as SessionSnapshot;
  }

  async destroySession(): Promise<void> {
    const res = await this.request("session.destroy");
    if (res.error) {
      throw new Error(res.error);
    }
  }

  // --- Service operations ---

  async listServices(): Promise<ServiceStatus[]> {
    const res = await this.request("services.list");
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as ServiceStatus[];
  }

  async startService(name: string): Promise<void> {
    const res = await this.request("services.start", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async stopService(name: string): Promise<void> {
    const res = await this.request("services.stop", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async restartService(name: string): Promise<void> {
    const res = await this.request("services.restart", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async rebuildDocker(name: string, overrides: Partial<DockerConfig>): Promise<void> {
    const res = await this.request("services.rebuild", { name, overrides });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async restartAll(): Promise<void> {
    const res = await this.request("services.restartAll");
    if (res.error) {
      throw new Error(res.error);
    }
  }

  async getLogSnapshot(service: string): Promise<string[]> {
    const res = await this.request("logs.snapshot", { service });
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as string[];
  }

  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  async runTask(
    key: string,
    callbacks: {
      onLine?: (line: string) => void;
      onProgress?: (taskKey: string, result: "success" | "error") => void;
    },
  ): Promise<{ success: boolean }> {
    const res = await ipcStream(
      this.socketPath,
      "tasks.run",
      { key },
      (event, data) => {
        if (event === "line") {
          callbacks.onLine?.(data as string);
        } else if (event === "progress") {
          const d = data as { key: string; result: "success" | "error" };
          callbacks.onProgress?.(d.key, d.result);
        }
      },
      120_000,
      this.sessionId,
    );
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as { success: boolean };
  }

  // --- Internal ---

  private async request(method: string, params?: unknown): Promise<IpcResponse> {
    return ipcRequest(this.socketPath, method, params, 30_000, this.sessionId);
  }

  private handleEvent(event: DaemonEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "service.stateChange": {
        this.emit("service.stateChange", data["name"], data["status"]);
        break;
      }
      case "log.lines": {
        this.emit("log.lines", data["service"], data["lines"]);
        break;
      }
      case "task.start": {
        this.emit("task.start", data["key"], data["name"]);
        break;
      }
      case "task.complete": {
        this.emit("task.complete", data["key"], data["name"], data["result"]);
        break;
      }
      case "session.destroyed": {
        this.emit("session.destroyed");
        break;
      }
      default: {
        break;
      }
    }
  }
}
