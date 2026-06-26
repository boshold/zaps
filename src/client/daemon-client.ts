import { EventEmitter } from "node:events";

import type { DockerConfig, NoticeLevel } from "#src/config/types.js";
import type { SessionSnapshot } from "#src/daemon/session.js";
import type { TaskOutputSnapshot } from "#src/daemon/task-output-store.js";
import type { IpcSubscription } from "#src/lib/ipc/client.js";
import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent, IpcResponse } from "#src/lib/ipc/protocol.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

export interface DaemonClientEvents {
  "service.stateChange": (name: string, status: ServiceStatus) => void;
  "log.lines": (service: string, lines: string[]) => void;
  "task.start": (key: string, name: string, runId?: string) => void;
  "task.complete": (key: string, name: string, result: "success" | "error", runId?: string) => void;
  "session.destroyed": () => void;
  "session.configReloaded": (snapshot: SessionSnapshot) => void;
  "session.configStale": () => void;
  "session.paneMap": (paneMap: Record<string, string>) => void;
  "config.notice": (level: NoticeLevel, message: string) => void;
  disconnect: () => void;
}

/**
 * High-level client for TUI to communicate with daemon.
 * Subscribes to events and provides methods for all session-scoped operations.
 */
export class DaemonClient extends EventEmitter {
  private readonly socketPath: string;
  private readonly sessionId: string;
  private sub: IpcSubscription | null = null;

  public constructor(socketPath: string, sessionId: string) {
    super();
    this.socketPath = socketPath;
    this.sessionId = sessionId;
  }

  public connect(): void {
    this.sub = ipcSubscribe(
      this.socketPath,
      this.sessionId,
      ["service.*", "log.*", "task.*", "session.*", "config.*"],
      (event: DaemonEvent) => {
        this.handleEvent(event);
      },
      () => {
        this.emit("disconnect");
      },
    );
  }

  public disconnect(): void {
    if (this.sub) {
      // Send detach before closing
      this.sub.send("session.detach");
      this.sub.close();
      this.sub = null;
    }
  }

  public get connected(): boolean {
    return this.sub?.connected ?? false;
  }

  public get session(): string {
    return this.sessionId;
  }

  // --- Session operations ---

  public async reloadConfig(): Promise<void> {
    const res = await this.request("session.reload");
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async attach(): Promise<SessionSnapshot> {
    const res = await this.request("session.attach");
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as SessionSnapshot;
  }

  public async destroySession(): Promise<void> {
    const res = await this.request("session.destroy");
    if (res.error) {
      throw new Error(res.error);
    }
  }

  // --- Service operations ---

  public async listServices(): Promise<ServiceStatus[]> {
    const res = await this.request("services.list");
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as ServiceStatus[];
  }

  public async startService(name: string): Promise<void> {
    const res = await this.request("services.start", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async stopService(name: string): Promise<void> {
    const res = await this.request("services.stop", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async restartService(name: string): Promise<void> {
    const res = await this.request("services.restart", { name });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async rebuildDocker(name: string, overrides: Partial<DockerConfig>): Promise<void> {
    const res = await this.request("services.rebuild", { name, overrides });
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async restartAll(): Promise<void> {
    const res = await this.request("services.restartAll");
    if (res.error) {
      throw new Error(res.error);
    }
  }

  public async getLogSnapshot(service: string): Promise<string[]> {
    const res = await this.request("logs.snapshot", { service });
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as string[];
  }

  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  public async runTask(
    key: string,
    callbacks: {
      onLine?: (line: string) => void;
      onProgress?: (taskKey: string, result: "success" | "error") => void;
    },
  ): Promise<{ success: boolean; runId?: string }> {
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
    return res.result as { success: boolean; runId?: string };
  }

  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  public async runTaskInPane(
    key: string,
    target?: "pane" | "window",
  ): Promise<{ runId: string; paneId: string }> {
    const res = await this.request("tasks.runInPane", {
      key,
      ...(target ? { target } : {}),
    });
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as { runId: string; paneId: string };
  }

  /**
   * Fetch a retained task-run output buffer for post-mortem inspection (used by
   * The failed-output overlay). Rejects with `not_found` when the buffer was
   * Evicted or the `runId` is unknown.
   */
  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  public async getTaskOutput(runId: string): Promise<TaskOutputSnapshot> {
    const res = await this.request("tasks.output", { runId });
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as TaskOutputSnapshot;
  }

  // --- Internal ---

  private async request(method: string, params?: unknown): Promise<IpcResponse> {
    return ipcRequest(this.socketPath, method, params, 30_000, this.sessionId);
  }

  private handleEvent(event: DaemonEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "service.stateChange": {
        this.emit("service.stateChange", data.name, data.status);
        break;
      }
      case "log.lines": {
        this.emit("log.lines", data.service, data.lines);
        break;
      }
      case "task.start": {
        this.emit("task.start", data.key, data.name, data.runId);
        break;
      }
      case "task.complete": {
        this.emit("task.complete", data.key, data.name, data.result, data.runId);
        break;
      }
      case "session.destroyed": {
        this.emit("session.destroyed");
        break;
      }
      case "session.configReloaded": {
        this.emit("session.configReloaded", data);
        break;
      }
      case "session.configStale": {
        this.emit("session.configStale");
        break;
      }
      case "session.paneMap": {
        this.emit("session.paneMap", data.paneMap);
        break;
      }
      case "config.notice": {
        this.emit("config.notice", data.level, data.message);
        break;
      }
      default: {
        break;
      }
    }
  }
}
