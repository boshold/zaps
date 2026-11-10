import { EventEmitter } from "node:events";

import { z } from "zod";

import type { DockerConfig, NoticeLevel } from "#src/config/types.js";
import type { ProjectedServiceStatus, SessionSnapshot } from "#src/daemon/session.js";
import type { TaskOutputSnapshot } from "#src/daemon/task-output-store.js";
import {
  backendErrorCodeSchema,
  terminalActionParamsSchema,
  terminalActionResultSchema,
} from "#src/lib/backend/schemas.js";
import type {
  BackendErrorCode,
  TerminalActionParams,
  TerminalActionResult,
} from "#src/lib/backend/schemas.js";
import {
  daemonEventDataSchemas,
  parseDaemonStatus,
  parseServiceStatus,
  parseSessionSnapshot,
} from "#src/lib/backend/wire.js";
import type { IpcSubscription } from "#src/lib/ipc/client.js";
import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent, IpcResponse } from "#src/lib/ipc/protocol.js";

export class DaemonRequestError extends Error {
  public override readonly name: string = "DaemonRequestError";
  public readonly code?: BackendErrorCode;
  public constructor(message: string, code?: BackendErrorCode) {
    super(message);
    const parsed = backendErrorCodeSchema.safeParse(code);
    this.code = parsed.success ? parsed.data : undefined;
  }
}

export class TerminalActionError extends DaemonRequestError {
  public override readonly name = "TerminalActionError";
}

export interface DaemonClientEvents {
  "service.stateChange": (name: string, status: ProjectedServiceStatus) => void;
  "log.lines": (service: string, lines: string[]) => void;
  "task.start": (key: string, name: string, runId?: string) => void;
  "task.complete": (key: string, name: string, result: "success" | "error", runId?: string) => void;
  "session.destroyed": () => void;
  "session.snapshot": (snapshot: SessionSnapshot) => void;
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
  private boundSubscription: IpcSubscription | null = null;

  private managedHost = true;
  private advertised = false;
  private upgradeNoticed = false;
  private connectionEpoch = 0;
  private upgradePending = false;
  private readonly supportsHostDetach: () => boolean;

  public constructor(
    socketPath: string,
    sessionId: string,
    // Trusted protocol support, supplied by connection metadata composition.
    options: { supportsHostDetach?: () => boolean; daemonStatus?: unknown } = {},
  ) {
    super();
    if (options.daemonStatus !== undefined) {
      this.advertised = parseDaemonStatus(options.daemonStatus).advertised;
    }
    this.supportsHostDetach = options.supportsHostDetach ?? (() => false);
    this.socketPath = socketPath;
    this.sessionId = sessionId;
  }

  public connect(): void {
    this.disconnect();
    this.openSubscription();
  }

  private openSubscription(): void {
    const epoch = this.connectionEpoch;
    this.sub = ipcSubscribe(
      this.socketPath,
      this.sessionId,
      ["service.*", "log.*", "task.*", "session.*", "config.*"],
      {
        onEvent: (event: DaemonEvent) => {
          if (epoch !== this.connectionEpoch) {
            return;
          }
          this.handleEvent(event);
        },
        onClose: () => {
          if (epoch !== this.connectionEpoch) {
            return;
          }
          this.connectionEpoch += 1;
          this.boundSubscription = null;
          this.sub = null;
          this.emit("disconnect");
        },
      },
    );
  }

  public disconnect(): void {
    this.connectionEpoch += 1;
    this.boundSubscription = null;
    if (this.sub) {
      // Send detach before closing
      const subscription = this.sub;
      this.sub = null;
      subscription.send("session.detach");
      subscription.close();
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
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public get uiBound(): boolean {
    return this.sub !== null && this.boundSubscription === this.sub && this.sub.connected;
  }

  public async connectUi(): Promise<SessionSnapshot> {
    this.disconnect();
    const epoch = this.connectionEpoch;
    const response = await this.request("daemon.status");
    if (epoch !== this.connectionEpoch) {
      throw new Error("daemon connection replaced");
    }
    if (response.error !== undefined) {
      throw new DaemonRequestError(response.error, response.errorCode);
    }
    this.advertised = parseDaemonStatus(response.result).advertised;
    this.openSubscription();
    try {
      return await this.bindUi();
    } catch (error) {
      if (epoch === this.connectionEpoch) {
        this.disconnect();
      }
      throw error;
    }
  }

  public async bindUi(): Promise<SessionSnapshot> {
    const subscription = this.sub;
    if (!subscription) {
      throw new Error("Not connected");
    }
    const epoch = this.connectionEpoch;
    await subscription.subscribed;
    if (epoch !== this.connectionEpoch || this.sub !== subscription || !subscription.connected) {
      throw new Error("daemon connection closed");
    }
    const response = await subscription.request("session.attach", { ui: true });
    if (response.error !== undefined) {
      throw new DaemonRequestError(response.error, response.errorCode);
    }
    if (epoch !== this.connectionEpoch || this.sub !== subscription || !subscription.connected) {
      throw new Error("daemon connection closed");
    }
    const snapshot = parseSessionSnapshot(response.result, this.advertised);
    this.managedHost = snapshot.backend === "tmux" && snapshot.managed;
    this.boundSubscription = subscription;
    this.emit("session.snapshot", snapshot);
    this.noticeUpgrade();
    return snapshot;
  }

  public async detach(options: { detachHost?: boolean } = {}): Promise<void> {
    const subscription = this.sub;
    if (!subscription || !subscription.connected || (options.detachHost && !this.uiBound)) {
      throw new TerminalActionError("invalid_request", "invalid_request");
    }
    if (options.detachHost && this.managedHost && !this.supportsHostDetach()) {
      throw new TerminalActionError(
        "Host detach unavailable. Detach tmux manually, then restart the daemon to upgrade.",
        "backend_unavailable",
      );
    }
    const response = await subscription.request("session.detach", options);
    if (response.error !== undefined) {
      throw new TerminalActionError(response.error, response.errorCode);
    }
    z.object({ detached: z.literal(true) }).parse(response.result);
    if (this.sub !== subscription || !subscription.connected) {
      throw new Error("daemon connection closed");
    }
    this.connectionEpoch += 1;
    this.boundSubscription = null;
    this.sub = null;
    subscription.close();
  }

  public async terminalAction(params: TerminalActionParams): Promise<TerminalActionResult> {
    const parsed = terminalActionParamsSchema.parse(params);
    const subscription = this.boundSubscription;
    if (!this.uiBound || !subscription) {
      throw new TerminalActionError("invalid_request", "invalid_request");
    }
    const response = await subscription.request("terminal.action", parsed, 0);
    if (response.error !== undefined) {
      throw new TerminalActionError(response.error, response.errorCode);
    }
    const result = terminalActionResultSchema.parse(response.result);
    if (result.action !== parsed.action) {
      throw new Error("Invalid terminal action response");
    }
    return result;
  }

  public async attach(): Promise<SessionSnapshot> {
    const res = await this.request("session.attach");
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
    const snapshot = parseSessionSnapshot(res.result, this.advertised);
    this.noticeUpgrade();
    return snapshot;
  }

  public async destroySession(): Promise<void> {
    const res = await this.request("session.destroy");
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  // --- Service operations ---

  public async listServices(): Promise<ProjectedServiceStatus[]> {
    const res = await this.request("services.list");
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
    return z
      .array(z.unknown())
      .parse(res.result)
      .map((status) => parseServiceStatus(status, this.advertised));
  }

  public async startService(name: string): Promise<void> {
    const res = await this.request("services.start", { name });
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public async stopService(name: string): Promise<void> {
    const res = await this.request("services.stop", { name });
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public async restartService(name: string): Promise<void> {
    const res = await this.request("services.restart", { name });
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public async rebuildDocker(name: string, overrides: Partial<DockerConfig>): Promise<void> {
    const res = await this.request("services.rebuild", { name, overrides });
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public async restartAll(): Promise<void> {
    const res = await this.request("services.restartAll");
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
  }

  public async getLogSnapshot(service: string): Promise<string[]> {
    const res = await this.request("logs.snapshot", { service });
    if (res.error) {
      throw new DaemonRequestError(res.error, res.errorCode);
    }
    return z.array(z.string()).parse(res.result);
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
      throw new DaemonRequestError(res.error, res.errorCode);
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
      throw new DaemonRequestError(res.error, res.errorCode);
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
      throw new DaemonRequestError(res.error, res.errorCode);
    }
    return res.result as TaskOutputSnapshot;
  }

  // --- Internal ---

  private async request(method: string, params?: unknown): Promise<IpcResponse> {
    return ipcRequest(this.socketPath, method, params, 30_000, this.sessionId);
  }

  public async status() {
    const response = await this.request("daemon.status");
    if (response.error !== undefined) {
      throw new DaemonRequestError(response.error, response.errorCode);
    }
    const status = parseDaemonStatus(response.result);
    this.advertised = status.advertised;
    this.noticeUpgrade();
    return status;
  }

  public async serviceDetails(name: string) {
    const response = await this.request("services.details", { name });
    if (response.error !== undefined) {
      throw new DaemonRequestError(response.error, response.errorCode);
    }
    const details = z
      .object({ dependsOn: z.array(z.string()), hasDocker: z.boolean() })
      .parse(response.result);
    return { ...parseServiceStatus(response.result, this.advertised), ...details };
  }

  private noticeUpgrade(): void {
    if (!this.advertised && !this.upgradeNoticed) {
      this.upgradePending = true;
    }
    this.deliverUpgradeNotice();
  }

  public deliverUpgradeNotice(): void {
    if (!this.upgradePending || this.listenerCount("config.notice") === 0) {
      return;
    }
    this.upgradePending = false;
    this.upgradeNoticed = true;
    this.emit(
      "config.notice",
      "warn",
      "Daemon capabilities unavailable. Restart the daemon to upgrade; detach managed tmux manually.",
    );
  }

  private handleEvent(event: DaemonEvent): void {
    try {
      this.decodeEvent(event);
    } catch {
      // Ignore malformed daemon events.
    }
  }

  private decodeEvent(event: DaemonEvent): void {
    const data = z.record(z.string(), z.unknown()).parse(event.data ?? {});
    switch (event.event) {
      case "service.stateChange": {
        const state = daemonEventDataSchemas.stateChange.parse(data);
        this.emit(
          "service.stateChange",
          state.name,
          parseServiceStatus(state.status, this.advertised),
        );
        break;
      }
      case "log.lines": {
        const log = daemonEventDataSchemas.logLines.parse(data);
        this.emit("log.lines", log.service, log.lines);
        break;
      }
      case "task.start": {
        const task = daemonEventDataSchemas.taskStart.parse(data);
        this.emit("task.start", task.key, task.name, task.runId);
        break;
      }
      case "task.complete": {
        const task = daemonEventDataSchemas.taskComplete.parse(data);
        this.emit("task.complete", task.key, task.name, task.result, task.runId);
        break;
      }
      case "session.destroyed": {
        this.disconnect();
        this.emit("session.destroyed");
        break;
      }
      case "session.configReloaded": {
        this.emit("session.configReloaded", parseSessionSnapshot(data, this.advertised));
        break;
      }
      case "session.configStale": {
        this.emit("session.configStale");
        break;
      }
      case "session.paneMap": {
        this.emit("session.paneMap", daemonEventDataSchemas.paneMap.parse(data).paneMap);
        break;
      }
      case "config.notice": {
        const notice = daemonEventDataSchemas.notice.parse(data);
        this.emit("config.notice", notice.level, notice.message);
        break;
      }
      default: {
        break;
      }
    }
  }
}
