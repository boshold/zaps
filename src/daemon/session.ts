import { createHash } from "node:crypto";
import type net from "node:net";

import type { TaskRunRecord } from "#src/components/TaskRunRecord.js";
import { loadConfig } from "#src/config/loader.js";
import type { ResolvedConfig } from "#src/config/types.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ExecInfo, ServiceStatus } from "#src/lib/service/types.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { killPane } from "#src/lib/tmux.js";

import { LogBuffer } from "./log-buffer.js";
import { LogMonitor } from "./log-monitor.js";

const MAX_TASK_HISTORY = 50;

type PaneMap = Record<string, string>;

export interface TaskInfo {
  key: string;
  name: string;
  description: string | null;
  shortcut?: string;
}

export interface ServiceMeta {
  name: string;
  dependsOn: string[];
  hasDocker: boolean;
  group?: string;
  dockerDefaults: {
    build: boolean;
    forceRecreate: boolean;
    renewVolumes: boolean;
    pull: boolean;
    removeOrphans: boolean;
  };
}

export interface SessionCreateParams {
  configPath: string;
  projectDir: string;
  config: ResolvedConfig;
  paneMap: PaneMap;
  tmuxSession: string;
  originPane: string;
  deps: ServiceManagerDeps;
}

export function sessionId(configPath: string): string {
  return createHash("sha256").update(configPath).digest("hex").slice(0, 12);
}

export class Session {
  public readonly id: string;
  public readonly configPath: string;
  public readonly projectDir: string;
  public readonly tmuxSession: string;
  public readonly originPane: string;
  public readonly subscribers = new Set<net.Socket>();
  public readonly createdAt = Date.now();
  public readonly taskHistory: TaskRunRecord[] = [];
  public readonly execInfo = new Map<string, ExecInfo>();
  public readonly deps: ServiceManagerDeps;

  public name: string;
  public config: ResolvedConfig;
  public paneMap: PaneMap;
  public manager: ServiceManager;
  public logBuffers: Map<string, LogBuffer>;
  public logMonitor: LogMonitor;
  /** Tracked in-flight `startAll`; reload/destroy abort then await its settlement. */
  public startPromise: Promise<void> | null = null;
  /** Set once `destroy()` runs; guards the reload-after-destroy race (A5). */
  public destroyed = false;
  /** Timestamp of the last successful config load — staleness source (A4). */
  public configLoadedAt: number;
  private reloading = false;
  // eslint-disable-next-line promise/prefer-await-to-then -- field initializer cannot use await
  private opChain: Promise<void> = Promise.resolve();

  public constructor(params: SessionCreateParams, manager: ServiceManager) {
    this.id = sessionId(params.configPath);
    this.name = params.config.project.name ?? "unnamed";
    this.configPath = params.configPath;
    this.projectDir = params.projectDir;
    this.config = params.config;
    this.paneMap = params.paneMap;
    this.tmuxSession = params.tmuxSession;
    this.originPane = params.originPane;
    this.deps = params.deps;
    this.manager = manager;
    this.configLoadedAt = Date.now();

    // Create log buffers per service
    this.logBuffers = new Map<string, LogBuffer>();
    for (const svcName of Object.keys(params.config.project.services)) {
      this.logBuffers.set(svcName, new LogBuffer());
    }

    // Log monitor: push new lines to buffers + broadcast to subscribers
    this.logMonitor = new LogMonitor(
      { capturePane: params.deps.capturePane },
      this.logBuffers,
      (serviceName, lines) => {
        this.broadcast({
          session: this.id,
          event: "log.lines",
          data: { service: serviceName, lines },
        });
      },
    );

    this.wireManagerEvents(manager);
  }

  private wireManagerEvents(manager: ServiceManager): void {
    // Forward service stateChange events to subscribers
    manager.on("stateChange", (svcName: string, status: ServiceStatus) => {
      this.broadcast({
        session: this.id,
        event: "service.stateChange",
        data: { name: svcName, status },
      });
    });

    manager.on("taskStart", (taskKey: string, taskName: string) => {
      this.pushTaskRecord({ taskKey, taskName, result: "running", timestamp: Date.now() });
      this.broadcast({
        session: this.id,
        event: "task.start",
        data: { key: taskKey, name: taskName },
      });
    });

    manager.on("taskComplete", (taskKey: string, taskName: string, result: "success" | "error") => {
      this.pushTaskRecord({ taskKey, taskName, result, timestamp: Date.now() });
      this.broadcast({
        session: this.id,
        event: "task.complete",
        data: { key: taskKey, name: taskName, result },
      });
    });
  }

  public pushTaskRecord(record: TaskRunRecord): void {
    if (record.result === "running") {
      this.taskHistory.unshift(record);
      if (this.taskHistory.length > MAX_TASK_HISTORY) {
        this.taskHistory.length = MAX_TASK_HISTORY;
      }
      return;
    }
    const runningIdx = this.taskHistory.findIndex(
      (r) => r.taskKey === record.taskKey && r.result === "running",
    );
    if (runningIdx !== -1) {
      this.taskHistory[runningIdx] = record;
    } else {
      this.taskHistory.unshift(record);
      if (this.taskHistory.length > MAX_TASK_HISTORY) {
        this.taskHistory.length = MAX_TASK_HISTORY;
      }
    }
  }

  /**
   * Start all services and begin log monitoring.
   */
  public async startAll(): Promise<void> {
    await this.manager.startAll();

    // Start log monitoring for each service pane.
    // For combined groups, start one monitor per shared pane and route to all children.
    const monitoredPanes = new Set<string>();
    for (const [svcName, paneId] of Object.entries(this.paneMap)) {
      if (svcName !== "@tui" && !monitoredPanes.has(paneId)) {
        monitoredPanes.add(paneId);
        this.logMonitor.start(svcName, paneId);
      }
    }

    // For combined children that share a pane, create buffer aliases
    // So logs requested by child name return the shared pane's output
    for (const [svcName] of Object.entries(this.paneMap)) {
      if (svcName !== "@tui" && !this.logBuffers.has(svcName)) {
        // Find which service's buffer covers this pane
        const paneId = this.paneMap[svcName];
        for (const [existingName, existingPaneId] of Object.entries(this.paneMap)) {
          const existingBuffer = this.logBuffers.get(existingName);
          if (existingPaneId === paneId && existingBuffer) {
            this.logBuffers.set(svcName, existingBuffer);
            break;
          }
        }
      }
    }
  }

  /**
   * Serialize reload/destroy: each runs only after the previous settles, so the
   * two never interleave their teardown/swap (A5).
   */
  private async withOpLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opChain;
    // eslint-disable-next-line promise/prefer-await-to-then -- promise-chain mutex by design
    const next = prev.then(fn, fn);
    this.opChain =
      // eslint-disable-next-line promise/prefer-await-to-then -- chain tail must never reject
      next.then(
        () => undefined,
        () => undefined,
      );
    return next;
  }

  /** Await the tracked `startAll` settlement without ever rejecting outward. */
  private async settleStartPromise(): Promise<void> {
    const pending = this.startPromise;
    if (pending) {
      await pending.catch(() => {
        /* Settled — errors surfaced via stateChange */
      });
    }
  }

  /**
   * Reload config, recreate layout, and restart services. Validate-then-swap: an
   * invalid config never tears down the running session (A1).
   */
  public async reload(): Promise<void> {
    if (this.destroyed) {
      throw new Error("session destroyed");
    }
    if (this.reloading) {
      throw new Error("reload already in progress");
    }
    this.reloading = true;
    try {
      await this.withOpLock(async () => {
        if (this.destroyed) {
          throw new Error("session destroyed");
        }
        await this._reload();
      });
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Rebuild the tmux layout, reserving the TUI's pane as `@tui`. On the rare
   * post-teardown failure, re-wire the old manager so the session stays
   * degraded-but-broadcasting before surfacing the error over IPC (A1).
   */
  private async rebuildLayout(tuiPaneId: string, newConfig: ResolvedConfig): Promise<PaneMap> {
    try {
      const { paneMap } = await createLayout(
        tuiPaneId,
        newConfig.project.layout,
        newConfig.project.services,
        newConfig.groups,
        { reserveTuiPane: true },
      );
      return paneMap;
    } catch (error) {
      this.wireManagerEvents(this.manager);
      throw error;
    }
  }

  private async _reload(): Promise<void> {
    // 1. Load + validate the new config FIRST. No teardown yet — on failure this
    // Throws verbatim and the running session is left fully intact (A1).
    const newConfig = await loadConfig(this.configPath, this.projectDir);
    const newConfigLoadedAt = Date.now();

    // 2. Cooperatively abort any in-flight startAll, then await its settlement.
    this.manager.abortStartAll();
    await this.settleStartPromise();

    // 3. Flush monitors, stop services, drop old listeners.
    await this.logMonitor.flushAll();
    await this.manager.stopAll();
    this.manager.removeAllListeners();

    // 4. Kill all non-TUI panes.
    const tuiPaneId = this.paneMap["@tui"];
    for (const [name, paneId] of Object.entries(this.paneMap)) {
      if (name !== "@tui") {
        await killPane(paneId).catch(() => {
          /* Best-effort cleanup */
        });
      }
    }

    // 5. Rebuild layout from the TUI pane (re-wires the old manager on failure).
    const paneMap = await this.rebuildLayout(tuiPaneId, newConfig);

    // 6. Build the new manager, buffers, and monitor before the swap.
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const newManager = new ServiceManager(newConfig, paneMap, this.deps, this.tmuxSession);
    const newLogBuffers = new Map<string, LogBuffer>();
    for (const svcName of Object.keys(newConfig.project.services)) {
      newLogBuffers.set(svcName, new LogBuffer());
    }
    const newLogMonitor = new LogMonitor(
      { capturePane: this.deps.capturePane },
      newLogBuffers,
      (serviceName, lines) => {
        this.broadcast({
          session: this.id,
          event: "log.lines",
          data: { service: serviceName, lines },
        });
      },
    );

    // 7. Swap every reference atomically (single synchronous block).
    this.config = newConfig;
    this.configLoadedAt = newConfigLoadedAt;
    this.paneMap = paneMap;
    this.name = newConfig.project.name ?? "unnamed";
    this.manager = newManager;
    this.logBuffers = newLogBuffers;
    this.logMonitor = newLogMonitor;

    this.wireManagerEvents(newManager);

    // 8. Broadcast reload event with full snapshot.
    this.broadcast({
      session: this.id,
      event: "session.configReloaded",
      data: this.attachSnapshot(),
    });

    // 9. Start services as a tracked promise.
    // eslint-disable-next-line promise/prefer-await-to-then -- tracked background start
    this.startPromise = this.startAll().catch(() => {
      /* Errors surfaced via stateChange */
    });
  }

  /**
   * Stop all services and clean up. Shares the op lock with `reload()` and uses
   * the same abort-then-await protocol (A5).
   */
  public async destroy(): Promise<void> {
    await this.withOpLock(async () => {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;

      this.manager.abortStartAll();
      await this.settleStartPromise();

      await this.logMonitor.flushAll();
      await this.manager.stopAll();

      // Notify subscribers of session destruction
      this.broadcast({ session: this.id, event: "session.destroyed", data: null });

      // Close subscriber sockets
      for (const sock of this.subscribers) {
        sock.destroy();
      }
      this.subscribers.clear();
    });
  }

  /**
   * Get attach snapshot: statuses + log snapshots for each service.
   */
  public attachSnapshot(): SessionSnapshot {
    const logSnapshots: Record<string, string[]> = {};
    for (const [svcName, buf] of this.logBuffers) {
      logSnapshots[svcName] = buf.snapshot();
    }

    // Compute task info with auto-assigned shortcuts
    const rawTasks = this.config.project.tasks ?? {};
    const shortcuts = getTaskShortcuts(rawTasks);
    const shortcutMap = new Map(shortcuts.map((s) => [s.name, s.shortcut]));
    const tasks: TaskInfo[] = Object.entries(rawTasks).map(([key, t]) => {
      const info: TaskInfo = { key, name: t.name, description: t.description ?? null };
      const shortcut = shortcutMap.get(t.name);
      if (shortcut) {
        info.shortcut = shortcut;
      }
      return info;
    });

    // Compute service metadata
    const servicesMeta: ServiceMeta[] = Object.entries(this.config.project.services).map(
      ([svcName, svc]) => ({
        name: svcName,
        dependsOn: svc.dependsOn ?? [],
        hasDocker: Boolean(svc.docker),
        group: svc._combined?.group,
        dockerDefaults: {
          build: svc.docker?.build ?? false,
          forceRecreate: svc.docker?.forceRecreate ?? false,
          renewVolumes: svc.docker?.renewVolumes ?? false,
          pull: svc.docker?.pull === "always",
          removeOrphans: svc.docker?.removeOrphans ?? false,
        },
      }),
    );

    return {
      id: this.id,
      name: this.name,
      paneMap: this.paneMap,
      tmuxSession: this.tmuxSession,
      originPane: this.originPane,
      statuses: this.manager.getAllStatuses(),
      logSnapshots,
      configPath: this.configPath,
      projectDir: this.projectDir,
      tasks,
      servicesMeta,
      taskHistory: this.taskHistory,
      unavailableServices: [...this.config.unavailableServices.values()],
    };
  }

  public broadcast(event: DaemonEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    for (const sock of this.subscribers) {
      if (sock.destroyed) {
        this.subscribers.delete(sock);
      } else {
        sock.write(line);
      }
    }
  }
}

export interface SessionSnapshot {
  id: string;
  name: string;
  paneMap: PaneMap;
  tmuxSession: string;
  originPane: string;
  statuses: ServiceStatus[];
  logSnapshots: Record<string, string[]>;
  configPath: string;
  projectDir: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  taskHistory: TaskRunRecord[];
  unavailableServices: { name: string; reason: string }[];
}
