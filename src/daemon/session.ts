import { createHash } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";

import type { TaskRunRecord } from "#src/components/TaskRunRecord.js";
import { loadConfig } from "#src/config/loader.js";
import type { ResolvedConfig, UiConfig } from "#src/config/types.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ExecInfo, ServiceStatus } from "#src/lib/service/types.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { killPane } from "#src/lib/tmux.js";

import { LogBuffer } from "./log-buffer.js";
import { LogMonitor } from "./log-monitor.js";

const MAX_TASK_HISTORY = 50;

/** How often a subscribed session re-stats its root config for staleness (A4). */
const STALE_POLL_MS = 10_000;

type PaneMap = Record<string, string>;

interface LogAllocation {
  /** Service name → shared buffer; group members on one pane share an instance. */
  buffers: Map<string, LogBuffer>;
  /** Monitor key (pane id) → buffer; one entry per monitored pane. */
  paneBuffers: Map<string, LogBuffer>;
  /** Monitor key (pane id) → the member service names sharing that pane. */
  paneMembers: Map<string, string[]>;
}

/**
 * Allocate one `LogBuffer` per unique pane and resolve every service name to the
 * shared instance for its pane (D2). Group names are layout expansion artifacts:
 * they never own a buffer and never surface as a key. A service without a pane
 * (future detached services) gets a private, unmonitored buffer so Phase 5 plugs
 * in without reshaping this map.
 */
function allocateLogBuffers(config: ResolvedConfig, paneMap: PaneMap): LogAllocation {
  const buffers = new Map<string, LogBuffer>();
  const paneBuffers = new Map<string, LogBuffer>();
  const paneMembers = new Map<string, string[]>();
  for (const svcName of Object.keys(config.project.services)) {
    const paneId = paneMap[svcName];
    if (paneId === undefined) {
      // No pane (detached) — private buffer, not polled by the pane monitor.
      buffers.set(svcName, new LogBuffer());
      continue;
    }
    let buffer = paneBuffers.get(paneId);
    if (!buffer) {
      buffer = new LogBuffer();
      paneBuffers.set(paneId, buffer);
      paneMembers.set(paneId, []);
    }
    buffers.set(svcName, buffer);
    paneMembers.get(paneId)?.push(svcName);
  }
  return { buffers, paneBuffers, paneMembers };
}

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
  isDetached?: boolean;
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
  /** Monitor key (pane id) → member service names sharing it; drives fan-out (D2). */
  private paneMembers: Map<string, string[]>;
  /** Tracked in-flight `startAll`; reload/destroy abort then await its settlement. */
  public startPromise: Promise<void> | null = null;
  /** Set once `destroy()` runs; guards the reload-after-destroy race (A5). */
  public destroyed = false;
  /** Timestamp of the last successful config load — staleness source (A4). */
  public configLoadedAt: number;
  /** Layout focus target — returned by `session.create` only (never attach) (E14). */
  public focusPane = "";
  private reloading = false;
  /** Subscriber-gated config-staleness poll; null when no subscribers (A4). */
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot guard so `session.configStale` fires once per false→true edge. */
  private staleNotified = false;
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

    // Per-pane log buffers + a monitor that fans new lines out to members (D2).
    const pipeline = this.buildLogPipeline(this.config, this.paneMap);
    this.logBuffers = pipeline.buffers;
    this.logMonitor = pipeline.monitor;
    this.paneMembers = pipeline.paneMembers;

    this.wireManagerEvents(manager);
  }

  /**
   * Build the per-pane buffers and a monitor whose capture callback fans a single
   * `log.lines` event out to every member service sharing that pane (D2). Used by
   * both construction and reload so the two allocation paths cannot drift.
   */
  private buildLogPipeline(
    config: ResolvedConfig,
    paneMap: PaneMap,
  ): { buffers: Map<string, LogBuffer>; monitor: LogMonitor; paneMembers: Map<string, string[]> } {
    const { buffers, paneBuffers, paneMembers } = allocateLogBuffers(config, paneMap);
    const monitor = new LogMonitor(
      { capturePane: this.deps.capturePane },
      paneBuffers,
      (paneId, lines) => {
        for (const member of paneMembers.get(paneId) ?? []) {
          this.broadcast({
            session: this.id,
            event: "log.lines",
            data: { service: member, lines },
          });
        }
      },
    );
    return { buffers, monitor, paneMembers };
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

    // Detached-service output: the runner streams lines straight from the child
    // (no pane to poll), so append to the service's buffer + broadcast here, the
    // Same shape the pane LogMonitor produces (D2/E4).
    manager.on("logLines", (svcName: string, lines: string[]) => {
      this.logBuffers.get(svcName)?.appendLines(lines);
      this.broadcast({
        session: this.id,
        event: "log.lines",
        data: { service: svcName, lines },
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

    // One monitor per unique pane, keyed by pane id; the monitor's listener fans
    // New lines out to every member service mapped to that pane (D2).
    for (const paneId of this.paneMembers.keys()) {
      this.logMonitor.start(paneId, paneId);
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

    // 6. Build the new manager + per-pane log pipeline before the swap. Reuses
    // The same allocation helper as construction so the two cannot drift.
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const newManager = new ServiceManager(newConfig, paneMap, this.deps, this.tmuxSession);
    const pipeline = this.buildLogPipeline(newConfig, paneMap);

    // 7. Swap every reference atomically (single synchronous block).
    this.config = newConfig;
    this.configLoadedAt = newConfigLoadedAt;
    // Fresh load clears staleness — re-arm so the next edit re-broadcasts (A4).
    this.staleNotified = false;
    this.paneMap = paneMap;
    this.name = newConfig.project.name ?? "unnamed";
    this.manager = newManager;
    this.logBuffers = pipeline.buffers;
    this.logMonitor = pipeline.monitor;
    this.paneMembers = pipeline.paneMembers;

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
      this.stopStalePoll();

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
   * Register a subscriber socket and arm the staleness poll on the 0→1 edge.
   */
  public addSubscriber(socket: net.Socket): void {
    this.subscribers.add(socket);
    if (!this.staleTimer && !this.destroyed) {
      this.startStalePoll();
    }
  }

  /**
   * Drop a subscriber socket and stop the staleness poll once none remain.
   */
  public removeSubscriber(socket: net.Socket): void {
    this.subscribers.delete(socket);
    if (this.subscribers.size === 0) {
      this.stopStalePoll();
    }
  }

  /** True if the root config file was modified after the last successful load. */
  public isConfigStale(): boolean {
    try {
      return fs.statSync(this.configPath).mtimeMs > this.configLoadedAt;
    } catch {
      // Can't stat (e.g. deleted mid-session) — don't claim staleness.
      return false;
    }
  }

  private startStalePoll(): void {
    if (this.staleTimer) {
      return;
    }
    this.staleTimer = setInterval(() => {
      this.checkConfigStale();
    }, STALE_POLL_MS);
    // Never keep the daemon alive solely for this poll.
    this.staleTimer.unref?.();
  }

  private stopStalePoll(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** Broadcast `session.configStale` once per false→true edge; re-arm when fresh. */
  private checkConfigStale(): void {
    if (this.isConfigStale()) {
      if (!this.staleNotified) {
        this.staleNotified = true;
        this.broadcast({
          session: this.id,
          event: "session.configStale",
          data: { configStale: true },
        });
      }
    } else {
      this.staleNotified = false;
    }
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
        isDetached: Boolean(svc.detached),
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
      configStale: this.isConfigStale(),
      ui: this.config.project.ui,
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
  /** Root config edited since the last load — drives the TUI reload hint (A4). */
  configStale: boolean;
  /** Resolved TUI presentation config (icons, notifications, thresholds). */
  ui?: UiConfig;
}
