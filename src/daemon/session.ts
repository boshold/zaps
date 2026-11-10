import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";

import type { TaskRunRecord } from "#src/components/TaskRunRecord.js";
import { computeBootSkip } from "#src/config/loader.js";
import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig, UiConfig } from "#src/config/types.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import {
  captureEnvironment,
  resolveEnvironment,
  runWithEnvironment,
} from "#src/lib/request-context.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ExecInfo, ServiceStatus } from "#src/lib/service/types.js";
import type { PaneRunInfo } from "#src/lib/task/run-in-pane.js";
import type { TaskPresentation } from "#src/lib/task/runner.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";
import type { LayoutReflow } from "#src/lib/tmux-reflow.js";
import { tmuxFor } from "#src/lib/tmux.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

import { LogBuffer } from "./log-buffer.js";
import { TaskExecutionService } from "./task-execution.js";

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
      // Detached services retain a private buffer.
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
  backend?: TmuxSessionBackend;
  configPath: string;
  projectDir: string;
  config: ResolvedConfig;
  paneMap: PaneMap;
  tmuxSession: string;
  tmuxWindow: string;
  originPane: string;
  deps: ServiceManagerDeps;
  /** Tmux server socket hosting this session (`null` = the user's default server). */
  tmuxSocket: string | null;
  /** True when zaps spawned and owns the tmux session (teardown kills it). */
  managedTmux: boolean;
  /** Shell environment forwarded by the CLI that created the session. */
  shellEnv?: Record<string, string>;
  /** Project .env merged with shellEnv. */
  env?: Record<string, string>;
}

export function sessionId(configPath: string, projectDir?: string): string {
  const hash = createHash("sha256").update(path.resolve(configPath));
  if (projectDir !== undefined) {
    hash.update("\0").update(path.resolve(projectDir));
  }
  return hash.digest("hex").slice(0, 12);
}

export interface UiBinding {
  readonly socket: net.Socket;
  readonly sessionId: string;
  readonly socketId: string;
  acknowledged: boolean;
  readonly controller: AbortController;
}

export class Session {
  public readonly backend: TmuxSessionBackend;
  public readonly id: string;
  public readonly configPath: string;
  public readonly projectDir: string;
  public readonly invokeDir: string;
  public readonly tmuxSession: string;
  public readonly tmuxWindow: string;
  public readonly originPane: string;
  public readonly subscribers = new Set<net.Socket>();
  private readonly acknowledgedSubscribers = new Set<net.Socket>();
  private readonly subscriptionRegistrations = new Map<net.Socket, symbol>();
  private readonly uiBindings = new Map<net.Socket, UiBinding>();
  public readonly createdAt = Date.now();
  public readonly taskExecution: TaskExecutionService;
  public taskPresentation?: TaskPresentation;

  public get taskHistory(): TaskRunRecord[] {
    return this.taskExecution.history;
  }
  public readonly execInfo = new Map<string, ExecInfo>();
  /** `runId → paneId` for run-in-pane runs, so the pane can later be addressed
   * (`paneExists`/`killPane`). Pane is left open on completion (Q13). */
  public readonly panesByRun = new Map<string, string>();
  /** `runId → resolve info + metadata` for run-in-pane runs, consumed by the
   * `exec-task` wrapper over IPC (parallel to `execInfo` for services). */
  public readonly paneRunInfo = new Map<string, PaneRunInfo>();
  /** Retained per-run task output for post-mortem inspection (`tasks.output`). */
  public get taskOutput() {
    return this.taskExecution.output;
  }
  public readonly deps: ServiceManagerDeps;
  /** Tmux server socket hosting this session (`null` = the user's default server). */
  public readonly tmuxSocket: string | null;
  /** True when zaps spawned and owns the tmux session (teardown kills it). */
  public readonly managedTmux: boolean;
  /** Every tmux command for this session runs through this socket-bound handle. */
  public readonly tmux: TmuxHandle;

  public name: string;
  public config: ResolvedConfig;
  public paneMap: PaneMap;
  public manager: ServiceManager;
  public logBuffers: Map<string, LogBuffer>;
  /** Legacy pane projection until execution-unit logs (P04-T05). */
  public paneBuffers: Map<string, LogBuffer>;
  /**
   * Monitor key (pane id) → member service names sharing it; drives fan-out (D2).
   * Public for the same reason `paneBuffers` is: dynamic insert/remove mutates
   * this map in lockstep with `paneBuffers`/`logBuffers`, and
   * tests need to assert the lockstep without surfacing a side accessor.
   */
  public paneMembers: Map<string, string[]>;
  /** Legacy adapter projection, removed by P06-T04. */
  public readonly reflow: LayoutReflow;
  /** Tracked in-flight `startAll`; reload/destroy abort then await its settlement. */
  public startPromise: Promise<void> | null = null;
  /** Set once `destroy()` runs; guards the reload-after-destroy race (A5). */
  public destroyed = false;
  /** Timestamp of the last successful config load — staleness source (A4). */
  public configLoadedAt: number;
  /** Layout focus target — returned by `session.create` only (never attach) (E14). */
  public focusPane = "";
  public shellEnv: Record<string, string>;
  public env: Record<string, string>;
  private destroyFailure?: AggregateError;
  private reloading = false;
  /** Subscriber-gated config-staleness poll; null when no subscribers (A4). */
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot guard so `session.configStale` fires once per false→true edge. */
  private staleNotified = false;
  // eslint-disable-next-line promise/prefer-await-to-then -- field initializer cannot use await
  private opChain: Promise<void> = Promise.resolve();

  public constructor(params: SessionCreateParams, manager: ServiceManager) {
    this.id = sessionId(params.configPath, params.config.projectDir);
    this.name = params.config.project.name ?? "unnamed";
    this.configPath = params.configPath;
    this.projectDir = params.config.projectDir;
    this.invokeDir = params.projectDir;
    this.shellEnv = params.shellEnv ?? captureEnvironment();
    this.env = params.env ?? resolveEnvironment(this.projectDir, this.shellEnv);
    this.config = params.config;
    this.paneMap = params.paneMap;
    this.tmuxSession = params.tmuxSession;
    this.tmuxWindow = params.tmuxWindow;
    this.originPane = params.originPane;
    this.deps = params.deps;
    this.tmuxSocket = params.tmuxSocket;
    this.managedTmux = params.managedTmux;
    this.tmux = tmuxFor(this.tmuxSocket);
    this.manager = manager;
    this.backend =
      params.backend ??
      TmuxSessionBackend.adopt(
        {
          host: {
            tmuxSession: this.tmuxSession,
            tmuxWindow: this.tmuxWindow,
            originPane: this.originPane,
            tmuxSocket: this.tmuxSocket,
            managedTmux: this.managedTmux,
          },
          tmux: this.tmux,
          runtime: params.deps.runtime(params.paneMap),
          layout: this.config.project.layout,
          services: this.config.project.services,
          groups: this.config.groups,
        },
        params.paneMap,
      );
    this.backend.subscribePresentation((view) => {
      if (view.kind !== "tmux") {
        return;
      }
      const previous = { ...this.paneMap };
      for (const name of Object.keys(this.paneMap)) {
        Reflect.deleteProperty(this.paneMap, name);
      }
      Object.assign(this.paneMap, view.paneMap);
      for (const [name, pane] of Object.entries(previous)) {
        if (name !== "@tui" && this.paneMap[name] !== pane) {
          this.freePaneLog(name, pane);
        }
      }
      for (const [name, pane] of Object.entries(this.paneMap)) {
        if (name !== "@tui" && previous[name] !== pane) {
          this.allocatePaneLog(name, pane);
        }
      }
      this.broadcastPaneMap();
    });
    this.configLoadedAt = Date.now();

    // Per-pane log buffers; runtime events feed ingestion.
    const pipeline = allocateLogBuffers(this.config, this.paneMap);
    this.logBuffers = pipeline.buffers;
    this.paneBuffers = pipeline.paneBuffers;
    this.paneMembers = pipeline.paneMembers;

    this.reflow = this.backend.legacyReflow;

    // P03-T06 replaces this injected bridge with the owned terminal driver.
    const { displayPopup } = this.deps;
    this.taskPresentation = {
      popup: async ({ commands, key: _key, ...request }) => {
        await displayPopup({
          ...request,
          command: `${commands.join(" && ")}; echo; echo 'Press Enter to close...'; read`,
        });
      },
    };
    this.taskExecution = new TaskExecutionService(this);
    this.taskExecution.bindManager(manager);
    this.wireManagerEvents(manager);
  }

  public updateContext(shellEnv: Record<string, string>): void {
    const nextShellEnv = { ...shellEnv };
    const nextEnv = resolveEnvironment(this.projectDir, nextShellEnv);
    this.shellEnv = nextShellEnv;
    this.env = nextEnv;
  }

  public runWithContext<T>(action: () => T): T {
    return runWithEnvironment({ ...this.env }, action);
  }

  private async updatePresentationTitle(manager: ServiceManager): Promise<void> {
    try {
      await this.backend.updateServiceTitle(manager.getAllStatuses());
    } catch {
      /* Cosmetic update. */
    }
  }

  private wireManagerEvents(manager: ServiceManager): void {
    // Forward service stateChange events to subscribers
    manager.on("stateChange", (svcName: string, status: ServiceStatus) => {
      void this.updatePresentationTitle(manager);
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
      const pane = this.paneMap[svcName];
      if (!pane || this.paneMembers.get(pane)?.[0] === svcName) {
        this.logBuffers.get(svcName)?.appendLines(lines);
      }
      this.broadcast({
        session: this.id,
        event: "log.lines",
        data: { service: svcName, lines },
      });
    });
  }

  public pushTaskRecord(record: TaskRunRecord): void {
    this.taskExecution.pushRecord(record);
  }

  /**
   * Start all services; runtime events feed logs.
   */
  public async startAll(): Promise<void> {
    await this.runWithContext(async () => {
      await this.manager.startAll();
    });
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
  public async reload(shellEnv = this.shellEnv): Promise<void> {
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
        await this._reload(shellEnv);
      });
    } finally {
      this.reloading = false;
    }
  }

  private async _reload(shellEnv: Record<string, string>): Promise<void> {
    // 1. Load + validate the new config FIRST. No teardown yet — on failure this
    // Throws verbatim and the running session is left fully intact (A1). The old
    // Session is alive throughout the load, so cli.warn/info/success notices
    // Broadcast to the attached TUI as toasts.
    const loaded = await loadProjectContext(this.configPath, this.invokeDir, shellEnv, (notice) => {
      this.broadcast({ session: this.id, event: "config.notice", data: notice });
    });
    const newConfig = loaded.config;
    if (newConfig.projectDir !== this.projectDir) {
      throw new Error("Project cwd changed. Run zaps down, then zaps up.");
    }
    const newConfigLoadedAt = Date.now();

    // 2. Cooperatively abort any in-flight startAll, then await its settlement.
    this.manager.abortStartAll();
    await this.settleStartPromise();

    // Stop services before detaching output observers.
    await this.manager.stopAll();
    this.manager.disposeObservers();

    try {
      await this.backend.reload(newConfig, computeBootSkip(newConfig));
    } catch (error) {
      this.manager.resumeRuntimeObserver();
      this.wireManagerEvents(this.manager);
      throw error;
    }
    const view = this.backend.getPresentation();
    const paneMap = view.kind === "tmux" ? { ...view.paneMap } : {};

    // 6. Build the new manager + per-pane log pipeline before the swap. Reuses
    // The same allocation helper as construction so the two cannot drift.
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const newManager = new ServiceManager(newConfig, paneMap, this.deps, this.tmuxSession);
    const pipeline = allocateLogBuffers(newConfig, paneMap);

    // 7. Swap every reference atomically (single synchronous block).
    this.config = newConfig;
    if (this.shellEnv === shellEnv) {
      this.env = loaded.env;
    }
    this.configLoadedAt = newConfigLoadedAt;
    // Fresh load clears staleness — re-arm so the next edit re-broadcasts (A4).
    this.staleNotified = false;
    this.paneMap = paneMap;
    this.name = newConfig.project.name ?? "unnamed";
    this.manager = newManager;
    this.logBuffers = pipeline.buffers;
    this.paneBuffers = pipeline.paneBuffers;
    this.paneMembers = pipeline.paneMembers;

    this.taskExecution.bindManager(newManager);
    this.wireManagerEvents(newManager);

    // 8. Broadcast reload event with full snapshot.
    this.broadcast({
      session: this.id,
      event: "session.configReloaded",
      data: this.attachSnapshot(),
    });

    // 9. Start services as a tracked promise.
    this.startPromise = this.runWithContext(async () => {
      try {
        await this.startAll();
      } catch {
        /* Errors surfaced via stateChange */
      }
    });
  }

  /**
   * Stop all services and clean up. Shares the op lock with `reload()` and uses
   * the same abort-then-await protocol (A5).
   */
  public async destroy(): Promise<void> {
    this.taskExecution.close();
    for (const binding of this.uiBindings.values()) {
      binding.controller.abort();
    }
    this.uiBindings.clear();
    this.acknowledgedSubscribers.clear();
    this.subscriptionRegistrations.clear();
    await this.withOpLock(async () => {
      if (this.destroyed) {
        if (this.destroyFailure) {
          throw this.destroyFailure;
        }
        return;
      }
      this.destroyed = true;
      this.stopStalePoll();

      this.manager.abortStartAll();
      await this.settleStartPromise();

      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<void>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(async () => this.manager.stopAll());
      this.manager.disposeObservers();
      await attempt(async () => this.taskExecution.dispose());

      // Notify subscribers of session destruction
      this.broadcast({ session: this.id, event: "session.destroyed", data: null });

      // Close subscriber sockets
      for (const sock of this.subscribers) {
        sock.destroy();
      }
      this.subscribers.clear();

      await attempt(async () => this.backend.dispose());
      if (errors.length) {
        this.destroyFailure = new AggregateError(errors, "Session cleanup incomplete");
        throw this.destroyFailure;
      }
    });
  }

  /**
   * Register a subscriber socket and arm the staleness poll on the 0→1 edge.
   */
  public addSubscriber(socket: net.Socket): void {
    this.acknowledgedSubscribers.delete(socket);
    this.uiBindings.get(socket)?.controller.abort();
    this.uiBindings.delete(socket);
    this.subscriptionRegistrations.set(socket, Symbol());
    this.subscribers.add(socket);
    if (!this.staleTimer && !this.destroyed) {
      this.startStalePoll();
    }
  }

  public subscriberAcknowledgement(socket: net.Socket): () => void {
    const registration = this.subscriptionRegistrations.get(socket);
    return () => {
      if (
        registration !== undefined &&
        this.subscriptionRegistrations.get(socket) === registration &&
        this.subscribers.has(socket) &&
        !socket.destroyed &&
        this.taskExecution.accepting
      ) {
        this.acknowledgedSubscribers.add(socket);
      }
    };
  }

  public bindUi(socket: net.Socket): void {
    if (!this.taskExecution.accepting) {
      throw new Error("session_closing");
    }
    if (!this.acknowledgedSubscribers.has(socket) || socket.destroyed || !socket.writable) {
      throw new Error("invalid_request");
    }
    this.uiBindings.get(socket)?.controller.abort();
    this.uiBindings.set(socket, {
      socket,
      sessionId: this.id,
      socketId: randomUUID(),
      acknowledged: false,
      controller: new AbortController(),
    });
  }

  public uiBindingAcknowledgement(socket: net.Socket): () => void {
    const binding = this.uiBindings.get(socket);
    return () => {
      if (
        binding &&
        this.uiBindings.get(socket) === binding &&
        !binding.controller.signal.aborted &&
        !socket.destroyed &&
        this.taskExecution.accepting
      ) {
        binding.acknowledged = true;
      }
    };
  }

  public getUiBinding(socket: net.Socket): UiBinding | undefined {
    return this.uiBindings.get(socket);
  }

  /** Drop socket ownership and stop polling when no subscribers remain. */
  public removeSubscriber(socket: net.Socket): void {
    this.uiBindings.get(socket)?.controller.abort();
    this.uiBindings.delete(socket);
    this.acknowledgedSubscribers.delete(socket);
    this.subscriptionRegistrations.delete(socket);
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
   * Public entry points for the manager's lazy-lifecycle wiring (P04-T04).
   * Both insert and remove run under the SESSION op-lock, so they cannot race
   * Each other or `_reload`. The op-lock is OUTERMOST: callers (manager
   * `startService`/`stopService` wrappers) MUST call these BEFORE/AFTER any
   * `withServiceLock`, NEVER while holding it — otherwise a concurrent manual
   * Start + reload deadlocks (reload holds op-lock → blocks on service-lock;
   * The other path holds service-lock → blocks on op-lock).
   */
  public async reflowInsert(name: string): Promise<void> {
    await this.withOpLock(async () => {
      await this.backend.insertPane(name);
    });
  }

  public async reflowRemove(name: string): Promise<void> {
    await this.withOpLock(async () => {
      await this.backend.removePane(name);
    });
  }

  /** Update legacy pane projections when adapter presentation changes. */
  public allocatePaneLog(name: string, paneId: string): void {
    // Idempotent fast path: already wired to this exact pane with the same
    // Pane-shared buffer → preserve membership and history
    // Without creating a new buffer (would orphan the previously-referenced
    // One and break any consumer holding a reference).
    const existingPaneBuf = this.paneBuffers.get(paneId);
    if (existingPaneBuf && this.logBuffers.get(name) === existingPaneBuf) {
      const members = this.paneMembers.get(paneId) ?? [];
      if (!members.includes(name)) {
        members.push(name);
        this.paneMembers.set(paneId, members);
      }
      return;
    }

    // Re-point: replace whatever buffer the service had (the pane-less private
    // One from boot, or a stale entry) with a fresh pane-shared `LogBuffer`.
    const buf = new LogBuffer();
    this.logBuffers.set(name, buf);
    this.paneBuffers.set(paneId, buf);
    this.paneMembers.set(paneId, [name]);
  }

  /** Retain stopped service history while dropping its pane projection. */
  public freePaneLog(_name: string, paneId: string): void {
    this.paneBuffers.delete(paneId);
    this.paneMembers.delete(paneId);
    // NOTE: `this.logBuffers[name]` is RETAINED on purpose — see method docstring.
  }

  /**
   * Push the current pane map to subscribers. Fired whenever a lazy pane is
   * inserted/removed so the TUI's `paneMap` (frozen at attach) stays live and
   * `z`/`E` resolve the right pane. A shallow copy is sent so the broadcast
   * can't be mutated by a later reflow before it serializes.
   */
  private broadcastPaneMap(): void {
    this.broadcast({
      session: this.id,
      event: "session.paneMap",
      data: { paneMap: { ...this.paneMap } },
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
      managed: this.managedTmux,
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
        this.removeSubscriber(sock);
      } else {
        try {
          sock.write(line);
        } catch {
          this.removeSubscriber(sock);
        }
      }
    }
  }
}

export interface SessionSnapshot {
  id: string;
  name: string;
  paneMap: PaneMap;
  tmuxSession: string;
  /** True when zaps owns the hosting tmux session (managed-tmux mode). */
  managed: boolean;
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
