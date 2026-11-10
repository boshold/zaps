import { EventEmitter } from "node:events";

import type { DockerConfig, ResolvedConfig, ServiceConfig } from "#src/config/types.js";
import type { ExecutionEvent, ExecutionHandle, RuntimeDriver } from "#src/lib/backend/types.js";
import {
  buildDockerCommand,
  composeProjectArgs,
  getContainerInfo,
  legacyProjectWarning,
} from "#src/lib/docker.js";
import { openInBrowser } from "#src/lib/open.js";
import { probePort } from "#src/lib/probe.js";
import { captureEnvironment, runWithEnvironment } from "#src/lib/request-context.js";
import {
  buildSentraEnv,
  sanitizeSegment,
  sentraLog,
  sentraTemplateFor,
} from "#src/lib/sentra/config.js";
import type { SentraDeps } from "#src/lib/sentra/config.js";
import { newRunId } from "#src/lib/task/run-id.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

import type { SpawnFn } from "./detached.js";
import { buildServiceContext, resolveEnv } from "./env.js";
import { buildRestartWithMap, reverseTopoSort, topoSort } from "./graph.js";
import { diffOutput } from "./output.js";
import { waitForReady } from "./ready.js";
import { canTransition, createServiceStatus, transition } from "./state.js";
import type {
  DisplayPopupOptions,
  DockerReadinessContext,
  ExecInfo,
  ReadyConfig,
  ReadyDeps,
  ServiceActionResult,
  ServiceContext,
  ServiceStatus,
} from "./types.js";

class GroupedDockerRebuildError extends Error {
  public readonly code = "unsupported_config";

  public constructor(name: string) {
    super(`Rebuild is not supported for grouped Docker service '${name}'; use plain restart.`);
    this.name = "GroupedDockerRebuildError";
  }
}

type PaneMap = Record<string, string>;

interface OwnedExecution {
  generation: number;
  handle?: ExecutionHandle;
  requestedStop: boolean;
  leaderExited: boolean;
  finalized: boolean;
  stoppedMembers?: Set<string>;
}

interface StartTarget {
  readyDeps: ReadyDeps;
  detectPorts: () => Promise<number[]>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommand(config: ServiceConfig, ctx: ServiceContext): string {
  if (config.docker && !config.start && !config.run) {
    const cwd = config.cwd ?? ctx.projectDir;
    // For combined owner: build command with ALL services in the group
    if (config._combined?.isOwner) {
      const groupDocker: DockerConfig = {
        ...config.docker,
        service: config._combined.allServices,
      };
      return buildDockerCommand(groupDocker, cwd);
    }
    return buildDockerCommand(config.docker, cwd);
  }
  const cmd = config.start ?? config.run;
  if (typeof cmd === "function") {
    return cmd(ctx);
  }
  return cmd ?? "";
}

/**
 * Build docker compose args for operating on a single service in a combined group.
 */
function buildDockerComposeArgs(
  action: "stop" | "start" | "restart",
  serviceName: string,
  composeFile: string | undefined,
  projectArgs: string[],
): string[] {
  const args = ["compose", ...projectArgs];
  if (composeFile) {
    args.push("-f", composeFile);
  }
  args.push(action, serviceName);
  return args;
}

function resolveReadyConfig(config: ServiceConfig): ReadyConfig | undefined {
  if (config.ready) {
    return config.ready;
  }
  if (config.docker) {
    return { docker: config.docker.service, file: config.docker.file };
  }
  return undefined;
}

function buildReadyDeps(
  serviceConfig: ServiceConfig,
  inputs: Pick<ReadyDeps, "detectPorts" | "readOutput">,
  projectDir: string,
  dockerReadiness?: DockerReadinessContext,
): ReadyDeps {
  const { docker } = serviceConfig;
  const projectArgs = docker ? composeProjectArgs(serviceConfig.cwd ?? projectDir, docker) : [];
  return {
    ...inputs,
    cwd: serviceConfig.cwd ?? projectDir,
    composeFile: docker?.file,
    dockerStatus: async (svc, cwd, composeFile) =>
      getContainerInfo(svc, cwd, composeFile, projectArgs),
    dockerReadiness,
  };
}

function resolveExplicitUrl(
  serviceConfig: ServiceConfig,
  ctx: ServiceContext,
): string | false | undefined {
  if (serviceConfig.url === false) {
    return false;
  }
  if (serviceConfig.url) {
    return typeof serviceConfig.url === "function" ? serviceConfig.url(ctx) : serviceConfig.url;
  }
  return undefined;
}

async function fireHook(
  hook?: (...args: string[]) => void | Promise<void>,
  ...args: string[]
): Promise<void> {
  if (hook) {
    await hook(...args);
  }
}

/**
 * Drive a service's `onOutput` hook per non-empty line. Errors are
 * swallowed — `onOutput` must never crash the service (E4).
 */
async function fireServiceOutput(
  onOutput: (line: string) => void | Promise<void>,
  lines: string[],
  isCurrent: () => boolean,
): Promise<void> {
  for (const line of lines) {
    if (!isCurrent()) {
      return;
    }
    if (line.trim() !== "") {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential per-line hook
        await onOutput(line);
      } catch {
        // The hook must not crash the service.
      }
    }
  }
}

async function tryAutoOpen(
  serviceConfig: ServiceConfig,
  name: string,
  url: string | undefined,
  autoOpened: Set<string>,
): Promise<void> {
  if (serviceConfig.flags?.open && url && !autoOpened.has(name)) {
    autoOpened.add(name);
    // Best-effort auto-open; a launch failure must not break the ready flow.
    await openInBrowser(url).catch(() => undefined);
  }
}

export class ServiceManager extends EventEmitter {
  private readonly statuses: Map<string, ServiceStatus>;
  private readonly abortControllers: Map<string, AbortController>;
  private readonly config: ResolvedConfig;
  private readonly paneMap: PaneMap;
  private readonly session: string;
  private shuttingDown = false;
  private startAllPromise: Promise<void> | null = null;
  private stopAllPromise: Promise<void> | null = null;
  /** Cooperative-abort flag for an in-flight `startAll` (reload/destroy). */
  private startAllAborted = false;
  private readonly deps: ServiceManagerDeps;
  private readonly autoOpened = new Set<string>();
  private readonly restartWithMap: Map<string, string[]>;
  private readonly cascadingTriggers = new Set<string>();
  private readonly lifecycleEpochs = new Map<string, number>();
  private readonly outputQueues = new Map<
    string,
    {
      unitId: string;
      generation: number;
      lifecycleEpoch: number;
      pending: Promise<void>;
    }
  >();
  private readonly runtime: RuntimeDriver;
  private readonly executions = new Map<string, OwnedExecution>();
  private readonly unitGenerations = new Map<string, number>();
  private readonly memberUnits = new Map<string, string>();
  private readonly unitMembers = new Map<string, string[]>();
  private readonly memberCleanupFailures = new Set<string>();
  private readonly pendingMemberStarts = new Map<string, number>();
  /** Per-service operation mutex: serializes start/stop/restart/rebuild (C8). */
  private readonly opLocks = new Map<string, Promise<void>>();
  /** Docker project names already checked for a legacy-project migration warning. */
  private readonly legacyWarned = new Set<string>();
  private readonly sentraDockerWarned = new Set<string>();
  private readonly originalWindowTitle: Promise<string>;
  private readonly originalAutoRename: Promise<string | null>;
  // eslint-disable-next-line promise/prefer-await-to-then -- field initializer cannot use await
  private pendingRename: Promise<void> = Promise.resolve();

  public constructor(
    config: ResolvedConfig,
    paneMap: PaneMap,
    deps: ServiceManagerDeps,
    session: string,
  ) {
    super();
    this.config = config;
    this.paneMap = paneMap;
    this.deps = deps;
    this.session = session;
    this.originalWindowTitle = deps.getWindowName(this.paneMap["@tui"]);
    const tuiPane = paneMap["@tui"];
    this.originalAutoRename = (async () => {
      try {
        return await deps.getWindowOption(tuiPane, "automatic-rename");
      } catch {
        return null;
      }
    })();
    this.statuses = new Map<string, ServiceStatus>();
    this.abortControllers = new Map<string, AbortController>();

    this.runtime = deps.runtime(paneMap);
    this.runtime.subscribe((event) => this.handleRuntimeEvent(event));

    // Initialize statuses for all services
    for (const [name, svc] of Object.entries(config.project.services)) {
      const status = createServiceStatus(name);
      if (svc.docker) {
        status.isDocker = true;
      }
      if (svc.detached) {
        status.isDetached = true;
      }
      if (svc._combined) {
        status.group = svc._combined.group;
      }
      this.statuses.set(name, status);
    }

    // Initialize unavailable service statuses
    for (const [name] of config.unavailableServices) {
      const status = createServiceStatus(name);
      status.state = "unavailable";
      this.statuses.set(name, status);
    }

    for (const [name, service] of Object.entries(config.project.services)) {
      const members = service._combined?.allServices ?? [name];
      const unitId =
        members.find((member) => config.project.services[member]?._combined?.isOwner) ?? name;
      this.memberUnits.set(name, unitId);
      this.unitMembers.set(unitId, members);
    }

    this.restartWithMap = buildRestartWithMap(config.project.services);

    this.on("stateChange", () => {
      this.updateWindowTitle();
    });

    // Bind library actions so lib methods work inside hooks
    config.bindActions?.({
      runTask: async (key) => {
        const tasks = config.project.tasks ?? {};
        if (!tasks[key]) {
          throw new Error(`Unknown task: ${key}`);
        }
        // One runId for the whole run; every event it emits carries it so the
        // Session can correlate history/output even across concurrent runs (Q12).
        const runId = newRunId();
        this.emit("taskStart", runId, key, tasks[key]?.name ?? key);
        const visited = new Set<string>();
        const results = new Map<string, "success" | "error">();
        const ok = await runTaskWithDeps(
          key,
          {
            tasks,
            statuses: this.statuses,
            projectDir: config.projectDir,
            services: config.project.services,
            tmux: { displayPopup: this.deps.displayPopup },
            sentra: this.deps.sentra,
            sentraConfig: config.project.sentra,
            onLine: (_taskKey, line) => {
              this.emit("taskLine", runId, line);
            },
            onProgress: (taskKey, result) => {
              this.emit("taskComplete", runId, taskKey, tasks[taskKey]?.name ?? taskKey, result);
            },
          },
          visited,
          results,
        );
        if (!ok) {
          throw new Error(`Task '${key}' failed`);
        }
      },
      startService: async (name) => {
        await this.startService(name);
      },
      restartService: async (name) => this.restartService(name),
      stopService: async (name) => {
        await this.stopService(name);
      },
      isServiceRunning: (name) => this.statuses.get(name)?.state === "ready",
    });
  }

  /**
   * Start all autostart services in topological order. Concurrent callers join
   * the same in-flight run (hooks fire exactly once); the shared promise is
   * cleared on settlement so a later call starts a fresh run.
   */
  /**
   * Serialize an operation on a service: it runs only after the previous
   * operation for the same name settles. The caller still sees the operation's
   * result/rejection; a rejection never poisons the chain for later operations.
   */
  private async withServiceLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.opLocks.get(name) ?? Promise.resolve();
    // eslint-disable-next-line promise/prefer-await-to-then -- promise-chain mutex by design
    const next = prev.then(fn, fn);
    this.opLocks.set(
      name,
      // eslint-disable-next-line promise/prefer-await-to-then -- chain tail must never reject
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  public async startAll(): Promise<void> {
    this.startAllPromise ??= this.runStartAll();
    await this.startAllPromise;
  }

  /**
   * Cooperatively abort an in-flight `startAll`: `startAllServices` checks the
   * flag between topo levels and before each service start, so a service already
   * mid-start finishes its start op and is then stopped by the caller's teardown.
   * Bumps every monitor generation so active crash/output monitors don't survive
   * the subsequent config swap (A5).
   */
  public abortStartAll(): void {
    this.startAllAborted = true;
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    for (const name of this.statuses.keys()) {
      this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);
    }
  }

  private async runStartAll(): Promise<void> {
    this.startAllAborted = false;
    // Capture-before-mutate: the constructor issues the original window title /
    // Automatic-rename reads asynchronously, but `startAllServices` emits state
    // Changes that drive `updateWindowTitle` → `renameWindow`, which flips
    // Automatic-rename off and overwrites the name. Awaiting the captures here
    // Guarantees they observe the pre-rename state so `stopAll` restores it
    // Correctly (otherwise they race and record our own rename under load).
    await Promise.all([this.originalWindowTitle, this.originalAutoRename]).catch(() => {
      // Reads are best-effort; stopAll handles null/unknown originals.
    });
    try {
      await this.startAllServices();
    } finally {
      this.startAllPromise = null;
    }
  }

  private async startAllServices(): Promise<void> {
    const { services, hooks } = this.config.project;

    await fireHook(hooks?.onBeforeStart);

    // Filter to autostart services
    const autostartServices: Record<string, { dependsOn?: string[] }> = {};
    for (const [name, svc] of Object.entries(services)) {
      if (svc.flags?.start !== false) {
        autostartServices[name] = { dependsOn: svc.dependsOn };
      }
    }

    // Deps pointing at non-autostart services are treated as satisfied (Q2):
    // Dropped from topoSort ordering (avoids a spurious "Circular dependency
    // Detected: unknown" — C1) and skipped in each startService dep check.
    const nonAutostartDeps = new Set(
      Object.keys(services).filter((n) => !(n in autostartServices)),
    );
    for (const entry of Object.values(autostartServices)) {
      if (entry.dependsOn) {
        entry.dependsOn = entry.dependsOn.filter((d) => d in autostartServices);
      }
    }

    const levels = topoSort(autostartServices);

    for (const level of levels) {
      if (this.startAllAborted) {
        return;
      }
      await Promise.all(
        level.map(async (name) => {
          if (this.startAllAborted) {
            return;
          }
          try {
            await this.startService(name, nonAutostartDeps);
          } catch (error) {
            // Surface dependency-not-ready on the dependent so it isn't a silent
            // "stopped" (C4); other failures are left to the crash monitor.
            this.recordStartFailure(name, error);
          }
        }),
      );
    }

    if (this.startAllAborted) {
      return;
    }

    await fireHook(hooks?.onStart);
  }

  /**
   * Record a failed start so dependents don't show a bare "stopped" with no
   * explanation. Dependency-not-ready maps to the `Dependency "X" not ready`
   * lastError; other errors are left for the crash monitor.
   */
  private recordStartFailure(name: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^Dependency "(?<dep>.+)" is not ready/u.exec(message);
    if (!match) {
      return;
    }
    const status = this.statuses.get(name);
    if (!status) {
      return;
    }
    status.lastError = `Dependency "${match.groups?.dep ?? ""}" not ready`;
    this.emit("stateChange", name, status);
  }

  /**
   * Stop all services in reverse topological order. Concurrent callers join the
   * same in-flight run and await its settlement (reload/destroy depend on the
   * stop having completed, not merely started — A5); the shared promise is
   * cleared on settle so a later call starts a fresh stop.
   */
  public async stopAll(): Promise<void> {
    this.stopAllPromise ??= this.runStopAll();
    await this.stopAllPromise;
  }

  private async runStopAll(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.stopAllServices();
    } finally {
      this.shuttingDown = false;
      this.stopAllPromise = null;
    }
  }

  private async stopAllServices(): Promise<void> {
    const { services, hooks } = this.config.project;
    const levels = reverseTopoSort(services);

    const failures: unknown[] = [];
    for (const level of levels) {
      await Promise.all(
        level.map(async (name) => {
          const status = this.statuses.get(name);
          if (status && status.state !== "unavailable") {
            try {
              await this.stopService(name);
            } catch (error) {
              failures.push(error);
            }
          }
        }),
      );
    }

    await fireHook(hooks?.onStop);

    await this.pendingRename.catch(() => {
      /* Ignored */
    });

    const autoRename = await this.originalAutoRename;
    await (
      autoRename === "on"
        ? this.deps.setWindowOption(this.paneMap["@tui"], "automatic-rename", "on")
        : this.deps.renameWindow(this.paneMap["@tui"], await this.originalWindowTitle)
    ).catch(() => {
      // Session may already be gone
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "Service cleanup incomplete");
    }
  }

  /**
   * Throw if any dependency isn't ready, skipping those in `satisfiedDeps`.
   */
  private assertDepsReady(
    name: string,
    serviceConfig: ServiceConfig,
    satisfiedDeps?: ReadonlySet<string>,
  ): void {
    for (const dep of serviceConfig.dependsOn ?? []) {
      if (satisfiedDeps?.has(dep)) {
        // eslint-disable-next-line no-continue -- non-autostart dep treated as satisfied
        continue;
      }
      const depStatus = this.statuses.get(dep);
      if (!depStatus || depStatus.state !== "ready") {
        throw new Error(`Dependency "${dep}" is not ready for service "${name}"`);
      }
    }
  }

  /**
   * Start a single service (serialized per service). `satisfiedDeps` lists
   * dependencies to treat as already satisfied without a readiness check — used
   * by `startAll` for non-autostart deps (Q2); explicit start calls enforce all.
   */
  public async startService(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
  ): Promise<ServiceActionResult> {
    return this.withMemberStart(name, async () => this.startServiceWithPane(name, satisfiedDeps));
  }

  private async withMemberStart<T>(name: string, start: () => Promise<T>): Promise<T> {
    const service = this.config.project.services[name];
    if (!service?._combined) {
      return start();
    }
    this.pendingMemberStarts.set(name, (this.pendingMemberStarts.get(name) ?? 0) + 1);
    try {
      return await start();
    } catch (error) {
      const status = this.getStatus(name);
      if (
        (status.state === "starting" || status.state === "stopping") &&
        !this.abortControllers.get(name)?.signal.aborted
      ) {
        status.state = transition(status.state, "error");
        status.lastError = error instanceof Error ? error.message : String(error);
        this.emit("stateChange", name, status);
      }
      throw error;
    } finally {
      const remaining = (this.pendingMemberStarts.get(name) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingMemberStarts.set(name, remaining);
      } else {
        this.pendingMemberStarts.delete(name);
        const unitId = this.memberUnits.get(name) ?? name;
        await this.withServiceLock(`@unit:${unitId}`, async () =>
          this.disposeStoppedCombinedUnit(unitId),
        );
      }
    }
  }

  private async startServiceWithPane(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
  ): Promise<ServiceActionResult> {
    // Lazy-pane services start pane-less and acquire their pane on first
    // Start (Flow B). MUST insert BEFORE `withServiceLock`:
    //   1. `startServiceInternal` (manager.ts:577) throws `Unknown service`
    //      If `paneMap[name]` is missing for a non-detached service, so the
    //      Insert is REQUIRED before the lock-guarded body runs.
    //   2. The reflow takes the SESSION op-lock; calling it INSIDE the per-
    //      Service lock would invert the global lock order (`reload` already
    //      Holds op-lock then takes service-lock via stopAll/startAll) and
    //      Deadlock a concurrent manual start + reload (Round-4 trap).
    // Already-paned (e.g. autostart after first start, or explicit
    // `lazyPane: true` on an autostart service) and detached services bypass
    // The reflow entirely — non-lazy behavior is byte-identical to before.
    // CRITICAL: skip reflowInsert during shutdown (reload/destroy). Same deadlock
    // Class as the reflowRemove guard in `stopService` — a `onStop` hook is
    // Allowed to call `lib.service.start`/`lib.service.restart` (config/builder.ts:49-53),
    // And `onStop` fires during reload's stopAll loop. Without this guard:
    //   Reload holds withOpLock → manager.stopAll → stopService(svc1) →
    //   StopServiceInternal → onStop hook → lib.service.start(svc2) →
    //   Deps.reflowInsert(svc2) → Session.reflowInsert → withOpLock (not
    //   Re-entrant) → chains AFTER the outer reload fn → permanent hang.
    // Safe to skip during shutdown: services aren't meaningfully starting
    // During stopAll, and `_reload` rebuilds the layout fresh via `createLayout
    // + computeBootSkip` afterwards — any service that ends up running post-
    // Reload gets its pane via the rebuild, not via a hook-driven reflowInsert
    // Mid-stopAll. `startServiceInternal` will throw `Unknown service` on the
    // Missing paneMap entry (existing contract); the hook's promise rejects,
    // Which is preferable to deadlocking the whole reload.
    const isLazy = this.config.lazyPaneByService.get(name) === true;
    if (!this.shuttingDown && isLazy && !this.paneMap[name]) {
      await this.deps.reflowInsert(name);
    }
    return this.withServiceLock(name, async () => this.startServiceInternal(name, satisfiedDeps));
  }

  private async startServiceInternal(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
    dockerOperation?: "restart",
  ): Promise<ServiceActionResult> {
    return this.withMemberStart(name, async () =>
      this.runServiceStart(name, satisfiedDeps, dockerOperation),
    );
  }

  private async runServiceStart(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
    dockerOperation?: "restart",
  ): Promise<ServiceActionResult> {
    const serviceConfig = this.config.project.services[name];
    const status = this.statuses.get(name);

    if (!serviceConfig || !status) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Idempotent no-op: already starting/ready (double-start race) or terminal
    // Unavailable. Returns a friendly no-op instead of throwing or double-acting.
    if (status.state === "starting" || status.state === "ready" || status.state === "unavailable") {
      return { noop: true };
    }

    this.assertDepsReady(name, serviceConfig, satisfiedDeps);
    if (!serviceConfig._combined) {
      await this.stopRuntimeExecution(name);
    }
    this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);

    // Create abort controller for this service
    const controller = new AbortController();
    this.abortControllers.set(name, controller);

    // Transition: stopped/error/restarting -> starting
    status.state = transition(status.state, "starting");
    status.startedAt = Date.now();
    this.emit("stateChange", name, status);

    // Fire per-service onBeforeStart hook
    try {
      await serviceConfig.onBeforeStart?.();
    } catch (error) {
      status.lastError = `onBeforeStart hook failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("stateChange", name, status);
    }

    if (controller.signal.aborted) {
      return { noop: false };
    }

    // Port pre-flight: fail fast with an actionable message instead of a silent
    // 60s ready timeout when an expected host port is already taken (B2). Runs
    // Only from the `starting` transition, so a restart's own listener is gone
    // (stop completed first, per the state machine ordering).
    const conflict = await this.deps.preflightPorts(serviceConfig, this.config.projectDir);
    if (controller.signal.aborted) {
      return { noop: false };
    }
    if (conflict) {
      status.state = transition(status.state, "error");
      status.lastError = conflict;
      delete status.readySince;
      this.emit("stateChange", name, status);
      this.abortControllers.delete(name);
      throw new Error(conflict);
    }

    const sentraEnv = await this.resolveServiceSentraEnv(name, serviceConfig, status);

    if (!controller.signal.aborted) {
      await this.startExecution(
        name,
        serviceConfig,
        status,
        controller,
        sentraEnv,
        dockerOperation,
      );
    }
    return { noop: false };
  }

  private async startExecution(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    controller: AbortController,
    sentraEnv: Record<string, string>,
    dockerOperation?: "restart",
  ): Promise<void> {
    if (serviceConfig._combined) {
      let operation: DockerReadinessContext["operation"] = "up";
      const unitId = this.memberUnits.get(name) ?? name;
      try {
        await this.withServiceLock(`@unit:${unitId}`, async () => {
          if (!controller.signal.aborted) {
            operation = await this.prepareCombinedStart(
              name,
              unitId,
              serviceConfig,
              sentraEnv,
              dockerOperation,
            );
          }
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          status.state = transition(status.state, "error");
          status.lastError = error instanceof Error ? error.message : String(error);
          this.emit("stateChange", name, status);
        }
        throw error;
      }
      const handle = this.executions.get(unitId)?.handle;
      if (name === unitId && handle && !controller.signal.aborted) {
        status.pid = await this.runtime.getPid(handle);
      }
      await this.finishRuntimeStart(name, unitId, serviceConfig, status, controller, operation);
      return;
    }
    await this.launchRuntimeExecution(name, serviceConfig, sentraEnv);
    const handle = this.executions.get(name)?.handle;
    if (handle && !controller.signal.aborted) {
      status.pid = await this.runtime.getPid(handle);
      await this.finishRuntimeStart(name, name, serviceConfig, status, controller);
    }
  }

  private async prepareCombinedStart(
    name: string,
    unitId: string,
    serviceConfig: ServiceConfig,
    sentraEnv: Record<string, string>,
    dockerOperation?: "restart",
  ): Promise<DockerReadinessContext["operation"]> {
    const members = this.unitMembers.get(unitId) ?? [name];
    const execution = this.executions.get(unitId);
    if (
      members.some((member) => this.memberCleanupFailures.has(member)) ||
      execution?.finalized ||
      execution?.leaderExited ||
      execution?.requestedStop
    ) {
      throw new Error(`Execution cleanup required for group "${serviceConfig._combined?.group}"`);
    }
    if (execution) {
      execution.stoppedMembers?.delete(name);
      if (dockerOperation === "restart") {
        return "restart";
      }
      this.memberCleanupFailures.add(name);
      await this.deps.exec(
        "docker",
        buildDockerComposeArgs(
          "start",
          name,
          serviceConfig.docker?.file,
          this.dockerProjectArgs(serviceConfig),
        ),
        serviceConfig.cwd ?? this.config.projectDir,
      );
      this.memberCleanupFailures.delete(name);
      return "start";
    }
    if (name !== unitId && !this.unitGenerations.has(unitId)) {
      return "up";
    }
    const ownerConfig = this.config.project.services[unitId];
    const env =
      name === unitId
        ? sentraEnv
        : await this.resolveServiceSentraEnv(unitId, ownerConfig, this.getStatus(unitId));
    await this.launchRuntimeExecution(unitId, ownerConfig, env);
    return "up";
  }

  private async launchRuntimeExecution(
    name: string,
    serviceConfig: ServiceConfig,
    sentraEnv: Record<string, string>,
  ): Promise<void> {
    const ctx = buildServiceContext(
      this.statuses,
      this.config.projectDir,
      this.config.project.services,
    );
    const command = resolveCommand(serviceConfig, ctx);
    const cwd = serviceConfig.cwd ?? this.config.projectDir;
    const env = { ...captureEnvironment(), ...sentraEnv, ...resolveEnv(serviceConfig.env, ctx) };
    if (serviceConfig.docker) {
      await this.warnLegacyDockerProject(serviceConfig, cwd);
    }
    const generation = (this.unitGenerations.get(name) ?? 0) + 1;
    this.unitGenerations.set(name, generation);
    const execution: OwnedExecution = {
      generation,
      requestedStop: false,
      leaderExited: false,
      finalized: false,
    };
    this.executions.set(name, execution);
    execution.handle = await this.runtime.start({
      unitId: name,
      generation,
      command,
      cwd,
      env,
      placement: serviceConfig.detached ? "background" : "default",
      raw: serviceConfig.raw ?? false,
    });
  }

  /**
   * Sentra env for an opted-in service (`{}` otherwise). Never fails the start:
   * an unavailable host only logs a warning.
   */
  private async resolveServiceSentraEnv(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
  ): Promise<Record<string, string>> {
    const { sentra } = this.deps;
    const template = sentraTemplateFor(this.config.project.sentra, serviceConfig.sentra);
    const receivesEnv = serviceConfig._combined?.isOwner !== false;
    if (!sentra || !template || !receivesEnv) {
      delete status.sentra;
      return {};
    }
    const env = await buildSentraEnv(sentra, template, name);
    status.sentra = env !== null;
    if (env) {
      sentra.onServiceStart?.(sanitizeSegment(name), status.startedAt ?? Date.now());
    }
    if (env && serviceConfig.docker && !this.sentraDockerWarned.has(name)) {
      this.sentraDockerWarned.add(name);
      sentraLog(
        sentra,
        `sentra: ${name} is a docker service; 127.0.0.1 in the DSN is not reachable from inside containers`,
      );
    }
    return env ?? {};
  }

  private async finishRuntimeStart(
    name: string,
    unitId: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    controller: AbortController,
    operation: DockerReadinessContext["operation"] = "up",
  ): Promise<void> {
    const execution = this.executions.get(unitId);
    const epoch = this.lifecycleEpochs.get(name);
    const currentHandle = (): ExecutionHandle | undefined =>
      !controller.signal.aborted &&
      this.lifecycleEpochs.get(name) === epoch &&
      this.executions.get(unitId) === execution
        ? execution?.handle
        : undefined;
    const detectPorts = async (): Promise<number[]> => {
      const handle = currentHandle();
      const pid = handle && (await this.runtime.getPid(handle));
      return pid === undefined || currentHandle() !== handle ? [] : this.deps.inspectPorts(pid);
    };
    const readOutput = async (tail: number): Promise<string> => {
      const handle = currentHandle();
      const lines = handle ? await this.runtime.readOutput(handle, tail) : [];
      return currentHandle() === handle ? lines.join("\n") : "";
    };
    await this.finishStart(name, serviceConfig, status, controller, {
      readyDeps: buildReadyDeps(
        serviceConfig,
        { detectPorts, readOutput },
        this.config.projectDir,
        serviceConfig.docker
          ? {
              memberEpoch: epoch ?? 0,
              operation,
              effectiveLaunch: {
                ...(operation === "up"
                  ? this.config.project.services[unitId].docker
                  : serviceConfig.docker),
              },
            }
          : undefined,
      ),
      detectPorts,
    });
  }

  private handleRuntimeEvent(event: ExecutionEvent): void {
    const execution = this.executions.get(event.unitId);
    if (!execution || execution.generation !== event.generation || execution.finalized) {
      return;
    }
    const members = this.unitMembers.get(event.unitId) ?? [event.unitId];
    if (event.kind === "output") {
      this.handleRuntimeOutput(event, execution, members);
      return;
    }
    if (!execution.leaderExited && !execution.requestedStop) {
      execution.leaderExited = true;
      for (const member of members) {
        this.abortControllers.get(member)?.abort();
        this.lifecycleEpochs.set(member, (this.lifecycleEpochs.get(member) ?? 0) + 1);
      }
    }
    if (event.kind === "leaderExit") {
      return;
    }
    this.handleRuntimeExit(event, execution);
  }

  private handleRuntimeOutput(
    event: ExecutionEvent & { kind: "output" },
    execution: OwnedExecution,
    members: string[],
  ): void {
    const shared = this.config.project.services[event.unitId]?._combined !== undefined;
    if (!shared && (execution.leaderExited || execution.requestedStop)) {
      return;
    }
    for (const member of members) {
      const state = this.statuses.get(member)?.state;
      if (shared || state === "starting" || state === "ready") {
        this.handleRuntimeLines(member, [...event.lines], event.unitId, event.generation);
      }
    }
  }

  private handleRuntimeExit(
    event: ExecutionEvent & { kind: "exit" },
    execution: OwnedExecution,
  ): void {
    execution.finalized = true;
    if (execution.requestedStop) {
      return;
    }
    const members = this.unitMembers.get(event.unitId) ?? [event.unitId];
    if (event.cleanupError) {
      for (const member of members) {
        this.publishCleanupFailure(member, event.cleanupError);
      }
      return;
    }
    this.executions.delete(event.unitId);
    for (const member of members) {
      const status = this.statuses.get(member);
      if (status?.state === "starting") {
        status.state = transition(status.state, "error");
        status.lastError = event.spawnError ?? "Process exited before becoming ready";
        delete status.readySince;
        this.emit("stateChange", member, status);
      } else if (status?.state === "ready") {
        void this.handleCrash(member, this.config.project.services[member], status);
      }
    }
  }

  /**
   * Wait for ready, resolve ports, and run the post-ready wiring — shared by the
   * pane and detached start paths. A stop that aborts mid-wait returns silently;
   * any other failure transitions to `error` with the message.
   */
  private async finishStart(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    controller: AbortController,
    target: StartTarget,
  ): Promise<void> {
    const epoch = this.lifecycleEpochs.get(name);
    const isCurrent = (): boolean =>
      !controller.signal.aborted && this.lifecycleEpochs.get(name) === epoch;
    try {
      const readyPorts = await waitForReady(
        resolveReadyConfig(serviceConfig),
        controller.signal,
        target.readyDeps,
      );

      if (!isCurrent()) {
        return;
      }

      const ports = readyPorts.length > 0 ? readyPorts : await target.detectPorts();
      if (!isCurrent()) {
        return;
      }

      status.state = transition(status.state, "ready");
      status.ports = ports;
      status.readySince = Date.now();

      const ctx = buildServiceContext(
        this.statuses,
        this.config.projectDir,
        this.config.project.services,
      );
      await this.onServiceReady(name, serviceConfig, status, ports, ctx, isCurrent);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      controller.abort();
      let message = error instanceof Error ? error.message : String(error);
      try {
        await (serviceConfig._combined
          ? this.stopCombinedService(name, serviceConfig)
          : this.stopRuntimeExecution(name));
      } catch (cleanupError) {
        message += `; cleanup failed: ${String(cleanupError)}`;
      }
      if (this.lifecycleEpochs.get(name) !== epoch) {
        return;
      }
      status.state = transition(status.state, "error");
      status.lastError = message;
      delete status.readySince;
      this.emit("stateChange", name, status);
    }
  }

  private handleRuntimeLines(
    name: string,
    lines: string[],
    unitId: string,
    generation: number,
  ): void {
    this.emit("logLines", name, lines);
    const onOutput = this.config.project.services[name]?.onOutput;
    if (!onOutput) {
      return;
    }
    const lifecycleEpoch = this.lifecycleEpochs.get(name) ?? 0;
    const previous = this.outputQueues.get(name);
    const sameGeneration =
      previous?.unitId === unitId &&
      previous.generation === generation &&
      previous.lifecycleEpoch === lifecycleEpoch;
    const isCurrent = (): boolean => {
      const state = this.statuses.get(name)?.state;
      return (
        this.executions.get(unitId)?.generation === generation &&
        (this.lifecycleEpochs.get(name) ?? 0) === lifecycleEpoch &&
        (state === "starting" || state === "ready")
      );
    };
    const pending = sameGeneration ? previous.pending : Promise.resolve();
    this.outputQueues.set(name, {
      unitId,
      generation,
      lifecycleEpoch,
      // eslint-disable-next-line promise/prefer-await-to-then -- serialize runtime output batches
      pending: pending.then(async () => fireServiceOutput(onOutput, lines, isCurrent)),
    });
  }

  /** Resolve the compose `-p` project args for a docker service ([] otherwise). */
  private dockerProjectArgs(serviceConfig: ServiceConfig): string[] {
    return serviceConfig.docker
      ? composeProjectArgs(serviceConfig.cwd ?? this.config.projectDir, serviceConfig.docker)
      : [];
  }

  /** Emit a one-time best-effort warning if legacy (unpinned) containers exist. */
  private async warnLegacyDockerProject(serviceConfig: ServiceConfig, cwd: string): Promise<void> {
    if (!serviceConfig.docker) {
      return;
    }
    const key = `${cwd} ${serviceConfig.docker.file ?? ""}`;
    if (this.legacyWarned.has(key)) {
      return;
    }
    this.legacyWarned.add(key);
    try {
      const warning = await legacyProjectWarning(cwd, serviceConfig.docker);
      if (warning) {
        process.stderr.write(`Warning: ${warning}\n`);
      }
    } catch {
      // Best-effort — never block start.
    }
  }

  private async onServiceReady(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    ports: number[],
    ctx: ServiceContext,
    isCurrent: () => boolean,
  ): Promise<void> {
    const explicitUrl = resolveExplicitUrl(serviceConfig, ctx);
    if (explicitUrl === false || serviceConfig.docker) {
      // Url: false OR docker service — skip probing
    } else if (explicitUrl) {
      status.url = explicitUrl;
    } else {
      const url = await probePort(ports);
      if (!isCurrent()) {
        return;
      }
      status.url = url;
      if (!status.url && ports.length > 0) {
        void this.monitorUrl(name, ports);
      }
    }

    await tryAutoOpen(serviceConfig, name, status.url, this.autoOpened);
    if (!isCurrent()) {
      return;
    }
    this.emit("stateChange", name, status);

    try {
      await serviceConfig.onReady?.();
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      // Log but don't fail the service start
      status.lastError = `onReady hook failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("stateChange", name, status);
    }

    if (!isCurrent()) {
      return;
    }
    const gen = this.lifecycleEpochs.get(name) ?? 0;
    void this.monitorCrash(name, gen);
  }

  /**
   * Stop a single service (serialized per service).
   */
  public async stopService(name: string): Promise<ServiceActionResult> {
    this.abortControllers.get(name)?.abort();
    this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);
    // Stop the process inside `withServiceLock` (state machine + side effects),
    // Then drop the pane OUTSIDE the lock — same op-lock-outermost discipline
    // As `startService`. This is the ONLY call site for `reflowRemove`; crash
    // (`handleCrash`) and restart (`restartServiceInternal`) intentionally
    // Skip it so the pane survives across a crash-restart loop.
    const result = await this.withServiceLock(name, async () => this.stopServiceInternal(name));
    // CRITICAL: skip reflowRemove during shutdown (reload/destroy). The session
    // Op-lock holds `_reload`/`destroy`, which calls `manager.stopAll()`, which
    // Sets `this.shuttingDown = true` BEFORE iterating `stopAllServices`
    // (manager.ts:496). Without this guard, every stopService inside that loop
    // Would await `deps.reflowRemove` → `Session.reflowRemove` → `withOpLock`,
    // Which is a promise-chain mutex and not re-entrant — the inner reflow
    // Would chain AFTER the outer reload's `fn`, which is itself awaiting
    // `stopAll` → permanent hang. Skipping is correct in addition to safe:
    // `_reload` step 4 (session.ts:434-440) already kill-panes every non-`@tui`
    // Pane before rebuilding the layout, so a reflowRemove here would be both
    // Redundant and deadlock-prone. The manual stop path (no reload/destroy
    // In flight) still runs reflowRemove as intended.
    const isLazy = this.config.lazyPaneByService.get(name) === true;
    if (!this.shuttingDown && isLazy && this.paneMap[name] !== undefined) {
      await this.deps.reflowRemove(name);
    }
    return result;
  }

  private async stopServiceInternal(name: string): Promise<ServiceActionResult> {
    const serviceConfig = this.config.project.services[name];
    const status = this.statuses.get(name);

    if (!status || !serviceConfig) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Terminal rows can still own a live execution.
    if (
      status.state === "unavailable" ||
      (!this.executions.has(this.memberUnits.get(name) ?? name) &&
        !this.memberCleanupFailures.has(name) &&
        (status.state === "stopped" || status.state === "stopping" || status.state === "error"))
    ) {
      return { noop: true };
    }

    // Transition: ready/starting/restarting -> stopping
    if (status.state !== "stopping") {
      status.state = transition(status.state, "stopping");
    }
    this.emit("stateChange", name, status);

    // Abort any pending ready poll
    const controller = this.abortControllers.get(name);
    if (controller) {
      controller.abort();
    }

    // Invalidate any active crash/output monitors
    this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);

    const combined = serviceConfig?._combined;

    try {
      await (combined
        ? this.stopCombinedService(name, serviceConfig)
        : this.stopRuntimeExecution(name));
    } catch (error) {
      this.publishCleanupFailure(name, String(error));
      throw error;
    }

    // Transition: stopping -> stopped
    status.state = transition(status.state, "stopped");
    delete status.readySince;
    delete status.url;
    this.emit("stateChange", name, status);

    try {
      await serviceConfig.onStop?.();
    } catch (error) {
      // Log but don't fail the service stop
      status.lastError = `onStop hook failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("stateChange", name, status);
    }

    return { noop: false };
  }

  private publishCleanupFailure(name: string, message: string): void {
    const status = this.getStatus(name);
    if (canTransition(status.state, "error")) {
      status.state = transition(status.state, "error");
    }
    status.lastError = `Execution cleanup failed: ${message}`;
    delete status.readySince;
    this.emit("stateChange", name, status);
  }

  private async stopRuntimeExecution(name: string): Promise<void> {
    const execution = this.executions.get(name);
    if (!execution?.handle) {
      return;
    }
    execution.requestedStop = true;
    await this.runtime.stop(execution.handle);
    if (this.executions.get(name) === execution) {
      this.executions.delete(name);
    }
  }

  /**
   * Stop one member of a combined docker group via `docker compose stop`, then —
   * once every sibling is stopped, dispose the shared command.
   */
  private async stopCombinedService(name: string, serviceConfig: ServiceConfig): Promise<void> {
    await this.withServiceLock(`@unit:${this.memberUnits.get(name) ?? name}`, async () => {
      await this.stopCombinedMember(name, serviceConfig);
    });
  }

  private async stopCombinedMember(name: string, serviceConfig: ServiceConfig): Promise<void> {
    this.memberCleanupFailures.add(name);
    await this.deps.exec(
      "docker",
      buildDockerComposeArgs(
        "stop",
        name,
        serviceConfig.docker?.file,
        this.dockerProjectArgs(serviceConfig),
      ),
      serviceConfig.cwd ?? this.config.projectDir,
    );

    this.memberCleanupFailures.delete(name);
    const execution = this.executions.get(this.memberUnits.get(name) ?? name);
    if (execution) {
      execution.stoppedMembers ??= new Set();
      execution.stoppedMembers.add(name);
    }
    await this.disposeStoppedCombinedUnit(this.memberUnits.get(name) ?? name);
  }

  private async disposeStoppedCombinedUnit(unitId: string): Promise<void> {
    const members = this.unitMembers.get(unitId) ?? [unitId];
    const execution = this.executions.get(unitId);
    const allStopped = members.every((member) => {
      if (this.pendingMemberStarts.has(member) || this.memberCleanupFailures.has(member)) {
        return false;
      }
      const status = this.statuses.get(member);
      return (
        execution?.stoppedMembers?.has(member) ||
        !status ||
        status.state === "stopped" ||
        status.state === "error"
      );
    });
    if (allStopped) {
      await this.stopRuntimeExecution(unitId);
    }
  }

  /**
   * Restart a single service (serialized per service).
   */
  public async restartService(name: string): Promise<void> {
    return this.withMemberStart(name, async () => this.restartServiceWithPane(name));
  }

  private async restartServiceWithPane(name: string): Promise<void> {
    this.abortControllers.get(name)?.abort();
    this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);
    // Same lazy-pane invariant as `startService`: if the service is pane-less +
    // Lazy, ensure the pane exists BEFORE entering the lock-guarded body —
    // `restartServiceInternal` eventually calls `startServiceInternal`, which
    // Throws `Unknown service` on a missing pane. The OUTSIDE-the-lock
    // Placement keeps op-lock-outermost: the Round-4 trap stays closed for
    // Restart just as it is for start. A restart of an ALREADY-paned service
    // (the common "restart the running worker") sees `paneMap[name]` already
    // Set and skips this — preserving the existing pane id (P04-T04 Flow E).
    // CRITICAL: same shuttingDown guard as `startService` — `onStop` hooks can
    // Reach `lib.service.restart` during reload's stopAll loop; without the
    // Guard we'd re-enter withOpLock through reflowInsert and deadlock. See
    // `startService` for the full chain.
    const isLazy = this.config.lazyPaneByService.get(name) === true;
    if (!this.shuttingDown && isLazy && !this.paneMap[name]) {
      await this.deps.reflowInsert(name);
    }
    return this.withServiceLock(name, async () => this.restartServiceInternal(name));
  }

  private async restartServiceInternal(name: string): Promise<void> {
    return this.withMemberStart(name, async () => this.runServiceRestart(name));
  }

  private async runServiceRestart(name: string): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      throw new Error(`Unknown service: ${name}`);
    }

    const serviceConfig = this.config.project.services[name];
    const combined = serviceConfig?._combined;

    // Live shared commands survive every member restart.
    if (
      combined &&
      this.executions.has(this.memberUnits.get(name) ?? name) &&
      (status.state === "ready" || status.state === "starting")
    ) {
      // Abort any pending ready poll and invalidate active monitors so the old
      // Crash/output monitors don't survive alongside the new ones (C7).
      const controller = this.abortControllers.get(name);
      if (controller) {
        controller.abort();
      }
      this.lifecycleEpochs.set(name, (this.lifecycleEpochs.get(name) ?? 0) + 1);

      status.state = transition(status.state, "stopping");
      this.emit("stateChange", name, status);

      await this.withServiceLock(`@unit:${this.memberUnits.get(name) ?? name}`, async () => {
        this.memberCleanupFailures.add(name);
        await this.deps.exec(
          "docker",
          buildDockerComposeArgs(
            "restart",
            name,
            serviceConfig.docker?.file,
            this.dockerProjectArgs(serviceConfig),
          ),
          serviceConfig.cwd ?? this.config.projectDir,
        );
        this.memberCleanupFailures.delete(name);
      });

      status.state = transition(status.state, "stopped");
      delete status.readySince;
      delete status.url;
      this.emit("stateChange", name, status);

      status.retryCount = 0;
      await this.startServiceInternal(name, undefined, "restart");
    } else {
      // Stop if running
      await this.stopServiceInternal(name);

      // Reset retry count
      status.retryCount = 0;

      // Start
      await this.startServiceInternal(name);
    }

    // Cascade restart dependents (each goes through its own service lock)
    if (!this.cascadingTriggers.has(name)) {
      await this.cascadeRestart(name);
    }
  }

  /**
   * Cascade-restart services that declared restartWith for the trigger.
   */
  private async cascadeRestart(trigger: string): Promise<void> {
    const dependents = this.restartWithMap.get(trigger);
    if (!dependents || dependents.length === 0) {
      return;
    }

    this.cascadingTriggers.add(trigger);
    try {
      for (const dep of dependents) {
        const depStatus = this.statuses.get(dep);
        if (!depStatus || (depStatus.state !== "ready" && depStatus.state !== "starting")) {
          // eslint-disable-next-line no-continue -- skip non-running services
          continue;
        }
        await this.stopService(dep);
        depStatus.retryCount = 0;
        // eslint-disable-next-line no-await-in-loop -- sequential cascade restart
        await this.startService(dep);
      }
    } finally {
      this.cascadingTriggers.delete(trigger);
    }
  }

  /**
   * Restart a docker service with temporary flag overrides.
   */
  public async restartWithDockerOverrides(
    name: string,
    overrides: Partial<DockerConfig>,
  ): Promise<void> {
    return this.withServiceLock(name, async () =>
      this.restartWithDockerOverridesInternal(name, overrides),
    );
  }

  private async restartWithDockerOverridesInternal(
    name: string,
    overrides: Partial<DockerConfig>,
  ): Promise<void> {
    const serviceConfig = this.config.project.services[name];
    if (serviceConfig?._combined) {
      throw new GroupedDockerRebuildError(name);
    }
    if (!serviceConfig?.docker) {
      throw new Error(`Service "${name}" is not a docker service`);
    }

    // Snapshot inside the lock so a queued concurrent rebuild captures the
    // Restored config, not another rebuild's temporary overrides (C8).
    const original = { ...serviceConfig.docker };
    Object.assign(serviceConfig.docker, overrides);
    try {
      await this.restartServiceInternal(name);
    } finally {
      serviceConfig.docker = original;
    }
  }

  /**
   * Get status for a single service.
   */
  public getStatus(name: string): ServiceStatus {
    const status = this.statuses.get(name);
    if (!status) {
      throw new Error(`Unknown service: ${name}`);
    }
    return status;
  }

  /**
   * Get all service statuses.
   */
  public getAllStatuses(): ServiceStatus[] {
    return [...this.statuses.values()];
  }

  /**
   * Monitor a service for crashes and auto-restart.
   */
  private async monitorCrash(name: string, generation: number): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      return;
    }
    const config = this.config.project.services[name];
    const combined = config._combined;

    // Poll interval: 2s for raw-mode, 10s for wrapper-mode (exit notification is primary)
    const pollInterval = config.raw ? 2000 : 10_000;
    while (status.state === "ready") {
      await sleep(pollInterval);
      if (!this.isReadyEpoch(name, generation)) {
        return;
      }

      let crashed = false;

      if (combined) {
        // Combined docker service: check container status
        const info = await getContainerInfo(
          name,
          config.cwd ?? this.config.projectDir,
          config.docker?.file,
          this.dockerProjectArgs(config),
        );
        crashed = !info || info.state !== "running";
      } else {
        const handle = this.executions.get(name)?.handle;
        crashed = !handle || !(await this.runtime.isRunning(handle));
      }

      if (crashed) {
        // Re-check state and generation after async crash detection — stopService may have run
        if (!this.isReadyEpoch(name, generation)) {
          return;
        }
        if (!combined && !(await this.cleanCrashedExecution(name, generation))) {
          return;
        }
        if (!this.isReadyEpoch(name, generation + (combined ? 0 : 1))) {
          return;
        }
        await this.handleCrash(name, config, status);
        return;
      }
    }
  }

  private isReadyEpoch(name: string, epoch: number): boolean {
    return this.statuses.get(name)?.state === "ready" && this.lifecycleEpochs.get(name) === epoch;
  }

  private async cleanCrashedExecution(name: string, epoch: number): Promise<boolean> {
    const execution = this.executions.get(name);
    if (execution?.leaderExited || execution?.requestedStop) {
      return false;
    }
    this.abortControllers.get(name)?.abort();
    this.lifecycleEpochs.set(name, epoch + 1);
    try {
      await this.stopRuntimeExecution(name);
      return true;
    } catch (error) {
      this.publishCleanupFailure(name, String(error));
      return false;
    }
  }

  /**
   * Monitor a service for URL availability after initial probe fails.
   */
  private async monitorUrl(name: string, ports: number[]): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      return;
    }

    const epoch = this.lifecycleEpochs.get(name);
    const MAX_RETRIES = 5;
    let retries = 0;

    while (status.state === "ready" && !status.url && retries < MAX_RETRIES) {
      await sleep(2000);
      if (status.state !== "ready" || status.url || this.lifecycleEpochs.get(name) !== epoch) {
        return;
      }

      retries += 1;

      const result = await probePort(ports);
      if (this.lifecycleEpochs.get(name) !== epoch || status.state !== "ready") {
        return;
      }
      if (result) {
        status.url = result;
        await tryAutoOpen(this.config.project.services[name], name, result, this.autoOpened);
        this.emit("stateChange", name, status);
        return;
      }
    }
  }
  private updateWindowTitle(): void {
    if (this.shuttingDown) {
      return;
    }
    const counts: Record<string, number> = {};
    for (const status of this.statuses.values()) {
      if (status.state === "unavailable") {
        continue;
      }
      counts[status.state] = (counts[status.state] ?? 0) + 1;
    }

    const symbols: [string, string][] = [
      ["error", "✖"],
      ["starting", "◐"],
      ["restarting", "◐"],
      ["stopping", "◐"],
      ["ready", "●"],
      ["stopped", "○"],
    ];

    const parts: string[] = [];
    for (const [state, symbol] of symbols) {
      const count = counts[state] ?? 0;
      if (count > 0) {
        parts.push(`${symbol}${count}`);
      }
    }

    const title = parts.length > 0 ? `zaps (${parts.join(" ")})` : "zaps";
    this.pendingRename = this.chainRename(title);
    void this.pendingRename;
  }

  private async chainRename(title: string): Promise<void> {
    await this.pendingRename.catch(() => {
      /* Ignored */
    });
    await this.deps.renameWindow(this.paneMap["@tui"], title).catch(() => {
      // Best-effort cosmetic title update; the tmux window/server may be gone (e.g. teardown).
    });
  }

  private async handleCrash(
    name: string,
    config: ServiceConfig,
    status: ServiceStatus,
  ): Promise<void> {
    const env = this.deps.environment?.();
    if (env) {
      await runWithEnvironment(env, async () =>
        this.handleCrashWithEnvironment(name, config, status),
      );
      return;
    }
    await this.handleCrashWithEnvironment(name, config, status);
  }

  private async handleCrashWithEnvironment(
    name: string,
    config: ServiceConfig,
    status: ServiceStatus,
  ): Promise<void> {
    const restartConfig = config.restart;
    if (restartConfig && status.retryCount < (restartConfig.maxRetries ?? 3)) {
      const gen = this.lifecycleEpochs.get(name) ?? 0;
      status.state = transition(status.state, "restarting");
      status.retryCount += 1;
      delete status.readySince;
      this.emit("stateChange", name, status);

      const backoff = (restartConfig.backoff ?? 1000) * 2 ** (status.retryCount - 1);
      // Do NOT hold the service lock across the backoff sleep (would block user
      // Start/stop for the whole window — C3). Lock only the restart action.
      await sleep(backoff);
      await this.withServiceLock(name, async () => {
        // Re-check inside the lock: a user stop/restart may have queued ahead.
        // Bail if superseded (shutting down, generation bumped, or no longer in
        // The restarting state) — the superseding op owns the state (C3).
        if (
          this.shuttingDown ||
          (this.lifecycleEpochs.get(name) ?? 0) !== gen ||
          status.state !== "restarting"
        ) {
          return;
        }

        // The restart must never reject out of handleCrash (a leaked rejection
        // Reaches Node and could kill the daemon — C2); on failure, go to error.
        try {
          // Verify prior ownership is cleared before replacement.
          if (!config._combined) {
            await this.stopRuntimeExecution(name);
          }
          await this.startServiceInternal(name);
          await this.cascadeRestart(name);
        } catch (error) {
          if (canTransition(status.state, "error")) {
            status.state = transition(status.state, "error");
            delete status.readySince;
          }
          status.lastError = error instanceof Error ? error.message : String(error);
          this.emit("stateChange", name, status);
        }
      });
    } else {
      status.state = transition(status.state, "error");
      status.lastError = "Process exited unexpectedly";
      delete status.readySince;
      this.emit("stateChange", name, status);
    }
  }
}

export interface ServiceManagerEvents {
  stateChange: (name: string, status: ServiceStatus) => void;
  /** Run started; `runId` correlates this run's events/history (Q12). */
  taskStart: (runId: string, taskKey: string, taskName: string) => void;
  taskComplete: (
    runId: string,
    taskKey: string,
    taskName: string,
    result: "success" | "error",
  ) => void;
  /** A task output line from the hook-path runner; the session appends it to the
   * run's `TaskOutputStore` buffer (keyed by `runId`). */
  taskLine: (runId: string, line: string) => void;
  /** New detached-child log lines — the session appends + broadcasts them (E4). */
  logLines: (name: string, lines: string[]) => void;
}

export interface ServiceManagerDeps {
  runtime: (targets: Record<string, string>) => RuntimeDriver;
  inspectPorts: (rootPid: number) => Promise<number[]>;
  sendKeys: (target: string, keys: string) => Promise<void>;
  sendCtrlC: (target: string) => Promise<void>;
  panePid: (target: string) => Promise<number>;
  detectPorts: (paneTarget: string) => Promise<number[]>;
  /** PID-based port detection for detached services (no pane) (E4). */
  detectPortsForPid?: (pid: number) => Promise<number[]>;
  capturePane: (target: string, lines: number) => Promise<string>;
  getDescendantPids: (rootPid: number) => Promise<number[]>;
  /** Record a spawned detached child PID for orphan protection (R10). */
  recordDetached?: (pid: number) => void | Promise<void>;
  /** Drop a recorded detached child PID on clean stop/exit (R10). */
  removeDetached?: (pid: number) => void | Promise<void>;
  /** Overridable spawn for detached children (tests inject a fake) (E4). */
  detachedSpawn?: SpawnFn;
  renameWindow: (target: string, name: string) => Promise<void>;
  getWindowName: (target: string) => Promise<string>;
  getWindowOption: (target: string, option: string) => Promise<string>;
  setWindowOption: (target: string, option: string, value: string) => Promise<void>;
  /** Popup surface for hook-path popup tasks; bound to the session's tmux socket. */
  displayPopup: (opts: DisplayPopupOptions) => Promise<void>;
  exec: (cmd: string, args: string[], cwd?: string) => Promise<void>;
  /** Pre-flight expected host ports; returns a conflict message or null (B2). */
  preflightPorts: (serviceConfig: ServiceConfig, projectDir: string) => Promise<string | null>;
  storeExecInfo: (
    service: string,
    info: ExecInfo,
    executionId?: string,
    generation?: number,
  ) => void;
  sessionId: string;
  zapsCommand: string;
  /** Latest request-derived environment for this session. */
  environment?: () => Record<string, string>;
  /** Write a private, short-lived shell env file for raw pane commands. */
  environmentFile?: (env: Record<string, string>) => string;
  /** Remove an env file when the pane command could not be sent. */
  removeEnvironmentFile?: (filePath: string) => void;
  /**
   * Lazy-pane reflow hooks (P04-T04). Both run under the SESSION op-lock so they
   * Serialize against each other AND against `_reload` (no half-applied geometry
   * Visible across a config edit). `startService` calls `reflowInsert` BEFORE
   * Taking the per-service lock; `stopService` calls `reflowRemove` AFTER
   * Releasing it. The op-lock-outermost discipline is what prevents the
   * Round-4 deadlock (manual start + reload).
   */
  reflowInsert: (name: string) => Promise<void>;
  reflowRemove: (name: string) => Promise<void>;
  /** Sentra env injection; omitted = never injected. */
  sentra?: SentraDeps;
}

export { diffOutput, GroupedDockerRebuildError };
