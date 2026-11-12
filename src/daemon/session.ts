import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";

import type { TaskRunRecord } from "#src/components/TaskRunRecord.js";
import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig, UiConfig } from "#src/config/types.js";
import { SessionClosingError } from "#src/lib/backend/admission-error.js";
import { preflightBackendCompatibility } from "#src/lib/backend/compatibility.js";
import { abortable } from "#src/lib/backend/runtime/abortable.js";
import type {
  BackendCapabilities,
  PresentationSnapshot,
  ServiceActions,
  SessionBackend,
} from "#src/lib/backend/types.js";
import { sessionSnapshotSchema } from "#src/lib/backend/wire.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import {
  captureEnvironment,
  resolveEnvironment,
  runWithEnvironment,
} from "#src/lib/request-context.js";
import { resolveExecutionUnits } from "#src/lib/service/execution-units.js";
import { topoSort } from "#src/lib/service/graph.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ExecInfo, ServiceState, ServiceStatus } from "#src/lib/service/types.js";
import {
  ensureTaskServices,
  isStartPermitted,
  planTaskServices,
} from "#src/lib/task/ensure-services.js";
import type { TaskServiceEvent } from "#src/lib/task/ensure-services.js";
import type { PaneRunInfo } from "#src/lib/task/run-in-pane.js";
import { resolveTaskServiceRequirements } from "#src/lib/task/service-requirements.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";

import { LogBuffer } from "./log-buffer.js";
import { TaskExecutionService } from "./task-execution.js";

/** How often a subscribed session re-stats its root config for staleness (A4). */
const STALE_POLL_MS = 10_000;

type PaneMap = Record<string, string>;

function allocateLogBuffers(memberUnits: ReadonlyMap<string, string>): Map<string, LogBuffer> {
  const buffers = new Map<string, LogBuffer>();
  const unitBuffers = new Map<string, LogBuffer>();
  for (const [name, unitId] of memberUnits) {
    let buffer = unitBuffers.get(unitId);
    if (!buffer) {
      buffer = new LogBuffer();
      unitBuffers.set(unitId, buffer);
    }
    buffers.set(name, buffer);
  }
  return buffers;
}

type ProjectedServiceStatus = ServiceStatus & { actions: ServiceActions };

type CompatibilityProjection =
  | {
      backend: "shell";
      paneMap: PaneMap;
      tmuxSession?: never;
      managed?: never;
      originPane?: never;
      focusPane?: never;
    }
  | {
      backend: "tmux";
      paneMap: PaneMap;
      tmuxSession: string;
      managed: boolean;
      originPane: string;
      focusPane?: string;
    };

function compatibilityProjection(view: PresentationSnapshot): CompatibilityProjection {
  if (view.kind === "shell") {
    return { backend: "shell", paneMap: {} };
  }
  return {
    backend: "tmux",
    paneMap: { ...view.paneMap },
    tmuxSession: view.tmuxSession,
    managed: view.managedTmux,
    originPane: view.originPane,
    ...(view.focusPane === undefined ? {} : { focusPane: view.focusPane }),
  };
}

const INACTIVE_STATES: ReadonlySet<ServiceState> = new Set(["stopped", "stopping", "unavailable"]);

function activeServiceNames(manager: ServiceManager): Set<string> {
  return new Set(
    manager
      .getAllStatuses()
      .filter((status) => !INACTIVE_STATES.has(status.state))
      .map((status) => status.name),
  );
}

async function restartServices(
  manager: ServiceManager,
  config: ResolvedConfig,
  names: ReadonlySet<string>,
  log: (message: string) => void,
): Promise<void> {
  const { services } = config.project;
  const graph: Record<string, { dependsOn: string[] }> = {};
  for (const name of names) {
    if (Object.hasOwn(services, name)) {
      graph[name] = { dependsOn: (services[name].dependsOn ?? []).filter((d) => names.has(d)) };
    }
  }
  for (const name of topoSort(graph).flat()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Sequential start respects deps
      await manager.startService(name);
    } catch (error) {
      if (error instanceof SessionClosingError) {
        return;
      }
      log(`reload: cannot restart service ${name}: ${String(error)}`);
    }
  }
}

interface PrepareTaskOptions {
  start?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: TaskServiceEvent) => void;
}

export interface TaskInfo {
  key: string;
  name: string;
  description: string | null;
  shortcut?: string;
  /** Optional so snapshots from older daemons still parse. */
  requiredServices?: string[];
  autoStart?: boolean;
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
  backend: SessionBackend;
  configPath: string;
  projectDir: string;
  config: ResolvedConfig;
  deps: ServiceManagerDeps;
  /** Shell environment forwarded by the CLI that created the session. */
  shellEnv?: Record<string, string>;
  /** Project .env merged with shellEnv. */
  env?: Record<string, string>;
  startupPending?: boolean;
  ephemeral?: boolean;
  /** Daemon log; defaults to stderr. */
  log?: (message: string) => void;
  /** Invoked when an ephemeral session becomes unused; must destroy it via the store. */
  onAutoDestroy?: () => Promise<void>;
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
  public readonly backend: SessionBackend;
  private presentation: PresentationSnapshot;
  public readonly id: string;
  public readonly configPath: string;
  public readonly projectDir: string;
  public readonly invokeDir: string;
  public readonly subscribers = new Set<net.Socket>();
  private readonly acknowledgedSubscribers = new Set<net.Socket>();
  private readonly subscriptionRegistrations = new Map<net.Socket, symbol>();
  private readonly uiBindings = new Map<net.Socket, UiBinding>();
  public readonly createdAt = Date.now();
  private ephemeralFlag: boolean;
  private startupPendingFlag: boolean;
  private pendingTaskCount = 0;
  private autoDestroyScheduled = false;
  private readonly onAutoDestroy?: () => Promise<void>;
  private readonly log: (message: string) => void;
  public readonly taskExecution: TaskExecutionService;

  public get ephemeral(): boolean {
    return this.ephemeralFlag;
  }
  public get startupPending(): boolean {
    return this.startupPendingFlag;
  }
  public get pendingTasks(): number {
    return this.pendingTaskCount;
  }

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

  public name: string;
  public config: ResolvedConfig;
  public paneMap: PaneMap;
  public manager: ServiceManager;
  public logBuffers: Map<string, LogBuffer>;
  private memberUnits: Map<string, string>;
  /** Tracked in-flight `startAll`; reload/destroy abort then await its settlement. */
  public startPromise: Promise<void> | null = null;
  private initialStartup?: Promise<void>;
  /** Set once `destroy()` runs; guards the reload-after-destroy race (A5). */
  public destroyed = false;
  /** Timestamp of the last successful config load — staleness source (A4). */
  public configLoadedAt: number;
  public shellEnv: Record<string, string>;
  public env: Record<string, string>;
  private destroyFailure?: AggregateError;
  private reloading = false;
  private readonly closing = new AbortController();
  /** Aborted when the manager is about to close (reload/destroy); cuts off pending task preparation. */
  private preparation = new AbortController();
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
    this.backend = params.backend;
    this.presentation = this.backend.getPresentation();
    this.paneMap = compatibilityProjection(this.presentation).paneMap;
    this.deps = params.deps;
    this.manager = manager;
    this.configLoadedAt = Date.now();
    this.startupPendingFlag = params.startupPending === true;
    this.ephemeralFlag = params.ephemeral === true;
    this.onAutoDestroy = params.onAutoDestroy;
    this.log =
      params.log ??
      ((message) => {
        process.stderr.write(`${message}\n`);
      });

    this.memberUnits = resolveExecutionUnits(this.config);
    this.logBuffers = allocateLogBuffers(this.memberUnits);

    this.backend.subscribePresentation((view) => {
      const previousStatuses = this.projectStatuses();
      this.presentation = view;
      const next = compatibilityProjection(view).paneMap;
      for (const name of Object.keys(this.paneMap)) {
        Reflect.deleteProperty(this.paneMap, name);
      }
      Object.assign(this.paneMap, next);
      this.broadcastPaneMap();
      const previousByName = new Map(previousStatuses.map((status) => [status.name, status]));
      for (const status of this.projectStatuses()) {
        const before = previousByName.get(status.name);
        if (
          before?.paneId !== status.paneId ||
          JSON.stringify(before?.actions) !== JSON.stringify(status.actions)
        ) {
          this.broadcast({
            session: this.id,
            event: "service.stateChange",
            data: { name: status.name, status },
          });
        }
      }
    });

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
      await this.backend.presentation?.updateTitle(manager.getAllStatuses());
    } catch {
      /* Cosmetic update. */
    }
  }

  private wireManagerEvents(manager: ServiceManager): void {
    // Forward service stateChange events to subscribers
    manager.on("stateChange", (svcName: string, status: ServiceStatus) => {
      if (status.state === "starting") {
        this.clearEphemeral();
      }
      void this.updatePresentationTitle(manager);
      this.broadcast({
        session: this.id,
        event: "service.stateChange",
        data: { name: svcName, status: this.projectStatus(status) },
      });
    });

    manager.on("logLines", (svcName: string, lines: string[]) => {
      if (this.memberUnits.get(svcName) === svcName) {
        this.logBuffers.get(svcName)?.appendLines(lines);
      }
      this.broadcast({
        session: this.id,
        event: "log.lines",
        data: { service: svcName, lines },
      });
    });
  }

  /**
   * Ensure the services required by the task chain before it runs. Must finish
   * before any status snapshot so the task sees fresh ports/URLs.
   */
  public async prepareTask(
    key: string,
    options: PrepareTaskOptions = {},
  ): Promise<{ startedServices: string[] }> {
    if (!this.taskExecution.accepting || this.closing.signal.aborted) {
      throw new SessionClosingError();
    }
    const requirements = resolveTaskServiceRequirements(this.config.project.tasks ?? {}, key);
    if (requirements.services.length === 0) {
      return { startedServices: [] };
    }
    const { manager } = this;
    const sessionSignal = this.preparation.signal;
    const plan = planTaskServices(
      requirements,
      manager.getAllStatuses(),
      this.config.project.services,
      this.config.unavailableServices,
    );
    const pending = plan.filter((e) => e.action === "start" || e.action === "wait");
    if (
      pending.length > 0 &&
      !plan.some((e) => e.action === "blocked") &&
      isStartPermitted(plan, options.start)
    ) {
      this.broadcast({
        session: this.id,
        event: "task.preparing",
        data: { key, services: pending.map((e) => e.name) },
      });
    }
    try {
      const { started } = await this.runWithContext(async () =>
        ensureTaskServices(plan, {
          start: options.start,
          manager,
          signal: options.signal ? AbortSignal.any([options.signal, sessionSignal]) : sessionSignal,
          onEvent: options.onEvent,
          taskKey: key,
        }),
      );
      return { startedServices: started };
    } catch (error) {
      if (sessionSignal.aborted) {
        throw new SessionClosingError();
      }
      throw error;
    }
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

  public beginInitialStartup(): void {
    if (this.initialStartup) {
      return;
    }
    this.startupPendingFlag = false;
    this.clearEphemeral();
    const { manager, name } = this;
    const pending = this.startAll();
    this.startPromise = pending;
    this.initialStartup = (async () => {
      await pending;
      if (manager.getAllStatuses().some((status) => status.state === "error")) {
        throw new Error(`Session ${name}: one or more services failed to start.`);
      }
    })();
    // eslint-disable-next-line promise/prefer-await-to-then -- Observe without replacing the tracked promise.
    void this.initialStartup.catch(() => {
      /* Joiners observe the original outcome. */
    });
  }

  public async waitForInitialStartup(): Promise<void> {
    await this.initialStartup;
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
      await abortable(
        pending,
        AbortSignal.timeout(7000),
        "Startup cancellation deadline exceeded",
      ).catch(() => {
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
    if (this.closing.signal.aborted) {
      throw new SessionClosingError();
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
      if (this.preparation.signal.aborted && !this.closing.signal.aborted) {
        this.preparation = new AbortController();
      }
    }
  }

  private async _reload(shellEnv: Record<string, string>): Promise<void> {
    // 1. Load + validate the new config FIRST. No teardown yet — on failure this
    // Throws verbatim and the running session is left fully intact (A1). The old
    // Session is alive throughout the load, so cli.warn/info/success notices
    // Broadcast to the attached TUI as toasts.
    const loaded = await abortable(
      loadProjectContext(this.configPath, this.invokeDir, shellEnv, (notice) => {
        this.broadcast({ session: this.id, event: "config.notice", data: notice });
      }),
      this.closing.signal,
      new SessionClosingError(),
    );
    if (!this.taskExecution.accepting) {
      throw new SessionClosingError();
    }
    const newConfig = loaded.config;
    if (newConfig.projectDir !== this.projectDir) {
      throw new Error("Project cwd changed. Run zaps down, then zaps up.");
    }
    preflightBackendCompatibility(newConfig.project.services, this.backend.capabilities);
    const newConfigLoadedAt = Date.now();
    const restartOnly = this.startupPendingFlag ? activeServiceNames(this.manager) : undefined;

    // 2. Cooperatively abort any in-flight startAll, then await its settlement.
    this.preparation.abort();
    this.manager.closeAdmission();
    this.manager.abortStartAll();
    this.taskExecution.cancelPresentations();
    await this.settleStartPromise();

    // Stop services before detaching output observers.
    await this.manager.stopAll();
    this.manager.disposeObservers();

    try {
      await this.backend.presentation?.reload(newConfig);
    } catch (error) {
      this.manager.resumeRuntimeObserver();
      this.wireManagerEvents(this.manager);
      throw error;
    }
    const view = this.backend.getPresentation();
    const paneMap = view.kind === "tmux" ? { ...view.paneMap } : {};

    // 6. Build the new manager + unit log pipeline before the swap. Reuses
    // The same allocation helper as construction so the two cannot drift.
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const newManager = new ServiceManager(newConfig, this.deps);
    const memberUnits = resolveExecutionUnits(newConfig);
    const logBuffers = allocateLogBuffers(memberUnits);

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
    this.memberUnits = memberUnits;
    this.logBuffers = logBuffers;

    this.taskExecution.bindManager(newManager);
    this.wireManagerEvents(newManager);

    // 8. Broadcast reload event with full snapshot.
    this.broadcast({
      session: this.id,
      event: "session.configReloaded",
      data: this.attachSnapshot(),
    });

    if (!this.taskExecution.accepting) {
      newManager.closeAdmission();
      return;
    }

    // 9. Start services as a tracked promise. Task-only sessions restart only what ran.
    this.startPromise = runWithEnvironment({ ...loaded.env }, async () => {
      try {
        await (restartOnly
          ? restartServices(newManager, newConfig, restartOnly, this.log)
          : newManager.startAll());
      } catch {
        /* Errors surfaced via stateChange */
      }
    });
  }

  public closeAdmission(): void {
    this.closing.abort();
    this.preparation.abort();
    this.taskExecution.close();
    this.manager.closeAdmission();
    this.backend.runtime.closeAdmission();
    for (const binding of this.uiBindings.values()) {
      binding.controller.abort();
    }
    this.uiBindings.clear();
    this.acknowledgedSubscribers.clear();
    this.subscriptionRegistrations.clear();
  }

  /**
   * Stop all services and clean up. Shares the op lock with `reload()` and uses
   * the same abort-then-await protocol (A5).
   */
  public async destroy(): Promise<void> {
    this.closeAdmission();
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
      await attempt(async () => this.manager.disposeObservers());
      await attempt(async () => this.taskExecution.dispose());

      await attempt(async () => this.backend.dispose());
      for (const [runId, info] of this.paneRunInfo) {
        this.taskOutput.finish(runId, "error", Date.now());
        this.pushTaskRecord({
          runId,
          taskKey: info.taskKey,
          taskName: info.taskName,
          result: "error",
          timestamp: Date.now(),
          mode: "pane",
        });
        this.broadcast({
          session: this.id,
          event: "task.complete",
          data: { key: info.taskKey, name: info.taskName, result: "error", runId },
        });
      }
      this.paneRunInfo.clear();
      this.broadcast({ session: this.id, event: "session.destroyed", data: null });
      for (const sock of this.subscribers) {
        sock.destroy();
      }
      this.subscribers.clear();

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
      throw new SessionClosingError();
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

  public clearEphemeral(): void {
    this.ephemeralFlag = false;
  }

  /** Count a task request; the returned release re-checks ephemeral auto-destroy. */
  public acquireTask(): () => void {
    this.pendingTaskCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.pendingTaskCount -= 1;
      this.scheduleAutoDestroy();
    };
  }

  private isUnused(): boolean {
    return (
      this.ephemeralFlag &&
      this.pendingTaskCount === 0 &&
      this.subscribers.size === 0 &&
      !this.destroyed
    );
  }

  /** Deferred so the triggering IPC response is written first. */
  private scheduleAutoDestroy(): void {
    if (!this.onAutoDestroy || this.autoDestroyScheduled || !this.isUnused()) {
      return;
    }
    this.autoDestroyScheduled = true;
    setImmediate(() => {
      this.autoDestroyScheduled = false;
      void this.maybeAutoDestroy();
    });
  }

  private async maybeAutoDestroy(): Promise<void> {
    if (!this.onAutoDestroy || !this.isUnused()) {
      return;
    }
    try {
      await this.onAutoDestroy();
    } catch {
      /* The store callback logs its own failures. */
    }
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
    this.scheduleAutoDestroy();
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
      await this.backend.presentation?.insert(name);
    });
  }

  public async reflowRemove(name: string): Promise<void> {
    await this.withOpLock(async () => {
      await this.backend.presentation?.remove(name);
    });
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
      const info: TaskInfo = {
        key,
        name: t.name,
        description: t.description ?? null,
        requiredServices: resolveTaskServiceRequirements(rawTasks, key).services,
        autoStart: t.autoStart ?? false,
      };
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

    const { focusPane: _focusPane, ...host } = this.compatibilityProjection();
    return sessionSnapshotSchema.parse({
      id: this.id,
      name: this.name,
      ...host,
      capabilities: { ...this.backend.capabilities },
      statuses: this.projectStatuses(),
      logSnapshots,
      configPath: this.configPath,
      projectDir: this.projectDir,
      tasks,
      servicesMeta,
      taskHistory: this.taskHistory,
      unavailableServices: [...this.config.unavailableServices.values()],
      configStale: this.isConfigStale(),
      ui: this.config.project.ui,
    });
  }

  public compatibilityProjection(): CompatibilityProjection {
    return compatibilityProjection(this.presentation);
  }

  public projectStatuses(): ProjectedServiceStatus[] {
    return this.manager.getAllStatuses().map((status) => this.projectStatus(status));
  }

  public projectStatus(status: ServiceStatus): ProjectedServiceStatus {
    const { paneId: _stalePane, ...lifecycle } = status;
    const service = this.config.project.services[status.name];
    const map = this.presentation.kind === "tmux" ? this.presentation.paneMap : {};
    let pane = map[status.name];
    if (!pane && service?._combined) {
      const owner = service._combined.allServices.find(
        (name) => this.config.project.services[name]?._combined?.isOwner,
      );
      if (owner) {
        pane = map[owner];
      }
    }
    const available = Boolean(
      service && !service.detached && !this.config.unavailableServices.has(status.name) && pane,
    );
    const paneAvailable = available && this.backend.capabilities.panes;
    return {
      ...lifecycle,
      ports: [...status.ports],
      ...(available ? { paneId: pane } : {}),
      actions: {
        focus: paneAvailable,
        zoom: paneAvailable && this.backend.capabilities.zoom,
        editOutput: paneAvailable && this.backend.capabilities.popups,
      },
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

export type SessionSnapshot = (
  | Omit<Extract<CompatibilityProjection, { backend: "shell" }>, "focusPane">
  | Omit<Extract<CompatibilityProjection, { backend: "tmux" }>, "focusPane">
) & {
  capabilities: BackendCapabilities;
  id: string;
  name: string;
  statuses: ProjectedServiceStatus[];
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
};

export { compatibilityProjection };
export type { ProjectedServiceStatus };
