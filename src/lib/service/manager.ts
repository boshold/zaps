import { EventEmitter } from "node:events";

import type {
  CombinedServiceMeta,
  DockerConfig,
  ResolvedConfig,
  ServiceConfig,
} from "#src/config/types.js";
import {
  buildDockerCommand,
  composeProjectArgs,
  getContainerInfo,
  legacyProjectWarning,
} from "#src/lib/docker.js";
import { openInBrowser } from "#src/lib/open.js";
import { probePort } from "#src/lib/probe.js";
import { newRunId } from "#src/lib/task/run-id.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

import { DetachedRunner } from "./detached.js";
import type { SpawnFn } from "./detached.js";
import { buildServiceContext, formatEnvForShell, resolveEnv } from "./env.js";
import { buildRestartWithMap, reverseTopoSort, topoSort } from "./graph.js";
import { waitForReady } from "./ready.js";
import { canTransition, createServiceStatus, transition } from "./state.js";
import type {
  ExecInfo,
  ReadyConfig,
  ReadyDeps,
  ServiceActionResult,
  ServiceContext,
  ServiceStatus,
} from "./types.js";

type PaneMap = Record<string, string>;

/** Ready-detection + port-detection inputs that differ between pane and detached. */
interface StartTarget {
  /** `capturePane`/`ready` target — a pane id, or "" for detached (buffer-backed). */
  readyTarget: string;
  readyDeps: ReadyDeps;
  detectPorts: () => Promise<number[]>;
  detached: boolean;
}

/**
 * Longest tail of `prev` that equals the head of `current`, or null if none.
 */
function overlapLength(prev: string[], current: string[]): number | null {
  for (let overlap = Math.min(prev.length, current.length); overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (prev[prev.length - overlap + i] !== current[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return overlap;
    }
  }
  return null;
}

/**
 * Find new lines between two pane captures using line-overlap diffing.
 *
 * 1. Direct overlap on the full captures handles scrolling and plain appends.
 * 2. If that fails, retry with each capture's final line excluded: tmux may be
 *    rewriting it in place (progress bars, status lines), which would otherwise
 *    desync the search and re-emit the whole window (C6). Only the stable lines
 *    are returned; the volatile final line is held until a newer line appears.
 * 3. With no alignment, equal-size windows are the same buffer rewritten —
 *    prefer reporting nothing over re-emitting everything (C6).
 */
function diffOutput(prev: string[], current: string[]): string[] {
  // No baseline yet — everything is new.
  if (prev.length === 0) {
    return current;
  }

  const direct = overlapLength(prev, current);
  if (direct !== null) {
    return current.slice(direct);
  }

  const prevStable = prev.slice(0, -1);
  const currStable = current.slice(0, -1);
  const stable = overlapLength(prevStable, currStable);
  if (stable !== null) {
    return currStable.slice(stable);
  }

  return prev.length === current.length ? [] : current;
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
  deps: ServiceManagerDeps,
  projectDir: string,
): ReadyDeps {
  const { docker } = serviceConfig;
  const projectArgs = docker ? composeProjectArgs(serviceConfig.cwd ?? projectDir, docker) : [];
  return {
    detectPorts: deps.detectPorts,
    capturePane: deps.capturePane,
    cwd: serviceConfig.cwd ?? projectDir,
    composeFile: docker?.file,
    dockerStatus: async (svc, cwd, composeFile) =>
      getContainerInfo(svc, cwd, composeFile, projectArgs),
    dockerRequireRecreate: docker
      ? Boolean(docker.build || docker.forceRecreate || docker.renewVolumes)
      : undefined,
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
 * Drive a detached service's `onOutput` hook per non-empty line. Errors are
 * swallowed — `onOutput` must never crash the service (E4).
 */
async function fireDetachedOutput(
  onOutput: (line: string) => void | Promise<void>,
  lines: string[],
): Promise<void> {
  for (const line of lines) {
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
    await openInBrowser(url);
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
  private readonly monitorGenerations = new Map<string, number>();
  /** Runs pane-less `detached: true` services (E4). */
  private readonly detachedRunner: DetachedRunner;
  /** Per-service operation mutex: serializes start/stop/restart/rebuild (C8). */
  private readonly opLocks = new Map<string, Promise<void>>();
  /** Docker project names already checked for a legacy-project migration warning. */
  private readonly legacyWarned = new Set<string>();
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

    this.detachedRunner = new DetachedRunner({
      onLines: (service, lines) => {
        this.handleDetachedLines(service, lines);
      },
      onExit: (service, generation) => {
        this.handleDetachedExit(service, generation);
      },
      record: (pid) => deps.recordDetached?.(pid),
      unrecord: (pid) => deps.removeDetached?.(pid),
      spawn: deps.detachedSpawn,
    });

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
      openInBrowser: async (url) => openInBrowser(url),
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
    for (const name of this.statuses.keys()) {
      this.monitorGenerations.set(name, (this.monitorGenerations.get(name) ?? 0) + 1);
    }
  }

  private async runStartAll(): Promise<void> {
    this.startAllAborted = false;
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

    for (const level of levels) {
      await Promise.all(
        level.map(async (name) => {
          const status = this.statuses.get(name);
          if (
            status &&
            status.state !== "stopped" &&
            status.state !== "error" &&
            status.state !== "unavailable"
          ) {
            try {
              await this.stopService(name);
            } catch {
              // Best-effort stop
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
    const isLazy = this.config.lazyPaneByService.get(name) === true;
    if (isLazy && !this.paneMap[name]) {
      await this.deps.reflowInsert(name);
    }
    return this.withServiceLock(name, async () => this.startServiceInternal(name, satisfiedDeps));
  }

  private async startServiceInternal(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
  ): Promise<ServiceActionResult> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    // A detached service has no pane; the missing pane is only fatal for the
    // Pane-based start path (E4).
    if (!serviceConfig || !status || (!serviceConfig.detached && !paneTarget)) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Idempotent no-op: already starting/ready (double-start race) or terminal
    // Unavailable. Returns a friendly no-op instead of throwing or double-acting.
    if (status.state === "starting" || status.state === "ready" || status.state === "unavailable") {
      return { noop: true };
    }

    this.assertDepsReady(name, serviceConfig, satisfiedDeps);

    // Create abort controller for this service
    const controller = new AbortController();
    this.abortControllers.set(name, controller);

    // Transition: stopped/error/restarting -> starting
    status.state = transition(status.state, "starting");
    this.emit("stateChange", name, status);

    // Fire per-service onBeforeStart hook
    try {
      await serviceConfig.onBeforeStart?.();
    } catch (error) {
      status.lastError = `onBeforeStart hook failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("stateChange", name, status);
    }

    // Port pre-flight: fail fast with an actionable message instead of a silent
    // 60s ready timeout when an expected host port is already taken (B2). Runs
    // Only from the `starting` transition, so a restart's own listener is gone
    // (stop completed first, per the state machine ordering).
    const conflict = await this.deps.preflightPorts(serviceConfig, this.config.projectDir);
    if (conflict) {
      status.state = transition(status.state, "error");
      status.lastError = conflict;
      delete status.readySince;
      this.emit("stateChange", name, status);
      this.abortControllers.delete(name);
      throw new Error(conflict);
    }

    if (serviceConfig.detached) {
      await this.startDetachedService(name, serviceConfig, status, controller);
    } else {
      await this.sendStartCommand(name, serviceConfig, paneTarget);
      await this.finishStart(name, serviceConfig, status, controller, {
        readyTarget: paneTarget,
        readyDeps: buildReadyDeps(serviceConfig, this.deps, this.config.projectDir),
        detectPorts: async () => this.deps.detectPorts(paneTarget),
        detached: false,
      });
    }

    return { noop: false };
  }

  /**
   * Spawn a `detached: true` service pane-less and wait for it to become ready.
   * Ready/port detection are PID-based (no pane); `ready.output` reads the
   * runner's buffered child output instead of a pane capture (E4).
   */
  private async startDetachedService(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    controller: AbortController,
  ): Promise<void> {
    const ctx = buildServiceContext(
      this.statuses,
      this.config.projectDir,
      this.config.project.services,
    );
    const command = resolveCommand(serviceConfig, ctx);
    const cwd = serviceConfig.cwd ?? this.config.projectDir;
    // Detached children inherit the daemon env plus the service's resolved env
    // (pane services get this additively via a shell prefix).
    const env: NodeJS.ProcessEnv = { ...process.env, ...resolveEnv(serviceConfig.env, ctx) };
    const generation = this.monitorGenerations.get(name) ?? 0;

    const pid = this.detachedRunner.start({ service: name, command, cwd, env, generation });
    // Surface the real child pid so `services.list` carries it (was always
    // Undefined) and orphan/crash tooling can target the process group.
    status.pid = pid;

    const detectPorts = async (): Promise<number[]> => this.deps.detectPortsForPid?.(pid) ?? [];
    const readyDeps: ReadyDeps = {
      ...buildReadyDeps(serviceConfig, this.deps, this.config.projectDir),
      detectPorts,
      capturePane: async () => this.detachedRunner.getLines(name).join("\n"),
    };

    await this.finishStart(name, serviceConfig, status, controller, {
      readyTarget: "",
      readyDeps,
      detectPorts,
      detached: true,
    });
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
    try {
      const readyPorts = await waitForReady(
        resolveReadyConfig(serviceConfig),
        target.readyTarget,
        controller.signal,
        target.readyDeps,
      );

      if (controller.signal.aborted) {
        return;
      }

      const ports = readyPorts.length > 0 ? readyPorts : await target.detectPorts();

      status.state = transition(status.state, "ready");
      status.ports = ports;
      status.readySince = Date.now();

      const ctx = buildServiceContext(
        this.statuses,
        this.config.projectDir,
        this.config.project.services,
      );
      await this.onServiceReady(name, serviceConfig, status, ports, ctx, target.detached);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      status.state = transition(status.state, "error");
      status.lastError = error instanceof Error ? error.message : String(error);
      delete status.readySince;
      this.emit("stateChange", name, status);
    }
  }

  /**
   * Append detached child output to the session log path (via `logLines`) and
   * drive the `onOutput` hook — the detached analogue of the pane LogMonitor and
   * `monitorOutput` (E4).
   */
  private handleDetachedLines(name: string, lines: string[]): void {
    this.emit("logLines", name, lines);
    const onOutput = this.config.project.services[name]?.onOutput;
    if (onOutput) {
      void fireDetachedOutput(onOutput, lines);
    }
  }

  /**
   * Handle a detached child's exit. Generation-checked so a stop/restart that
   * bumped the generation never crash-restarts a stale child (E4). An exit while
   * still `starting` fails fast instead of waiting out the ready timeout.
   */
  private handleDetachedExit(name: string, generation: number): void {
    const status = this.statuses.get(name);
    if (!status) {
      return;
    }
    if ((this.monitorGenerations.get(name) ?? 0) !== generation) {
      return;
    }
    const config = this.config.project.services[name];

    if (status.state === "starting") {
      this.monitorGenerations.set(name, generation + 1);
      this.abortControllers.get(name)?.abort();
      if (canTransition(status.state, "error")) {
        status.state = transition(status.state, "error");
      }
      status.lastError = "Process exited before becoming ready";
      delete status.readySince;
      this.emit("stateChange", name, status);
      return;
    }

    if (status.state !== "ready") {
      return;
    }
    this.monitorGenerations.set(name, generation + 1);
    void this.handleCrash(name, config, status);
  }

  /**
   * Send the start command for a service — handles combined vs regular.
   */
  private async sendStartCommand(
    name: string,
    serviceConfig: ServiceConfig,
    paneTarget: string,
  ): Promise<void> {
    const combined = serviceConfig._combined;

    if (combined && !combined.isOwner) {
      // Combined non-owner: start individual container via docker compose
      const [ownerName] = combined.allServices;
      const ownerStatus = this.statuses.get(ownerName);
      if (ownerStatus && (ownerStatus.state === "ready" || ownerStatus.state === "starting")) {
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
      }
      // If owner not running, skip — the owner will start all containers
      return;
    }

    // Regular or combined owner: send command to pane
    const ctx = buildServiceContext(
      this.statuses,
      this.config.projectDir,
      this.config.project.services,
    );
    const env = resolveEnv(serviceConfig.env, ctx);
    const resolvedCommand = resolveCommand(serviceConfig, ctx);
    const cwd = serviceConfig.cwd ?? this.config.projectDir;

    // One-time best-effort migration warning when containers linger under the
    // Pre-pinning project name (B5). Never blocks start.
    if (serviceConfig.docker) {
      await this.warnLegacyDockerProject(serviceConfig, cwd);
    }

    if (serviceConfig.raw) {
      // Raw mode: current inline env approach
      const envPrefix = formatEnvForShell(env);
      const cmdWithEnv = envPrefix ? `${envPrefix} ${resolvedCommand}` : resolvedCommand;
      const command = `cd ${JSON.stringify(cwd)} && ${cmdWithEnv}`;
      await this.deps.sendKeys(paneTarget, command);
    } else {
      // Wrapper mode: store exec info, send wrapper command
      this.deps.storeExecInfo(name, { command: resolvedCommand, cwd, env });
      await this.deps.sendKeys(
        paneTarget,
        `${this.deps.zapsCommand} -s ${this.deps.sessionId} exec-service ${name}`,
      );
    }
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
    detached = false,
  ): Promise<void> {
    const explicitUrl = resolveExplicitUrl(serviceConfig, ctx);
    if (explicitUrl === false || serviceConfig.docker) {
      // Url: false OR docker service — skip probing
    } else if (explicitUrl) {
      status.url = explicitUrl;
    } else {
      status.url = await probePort(ports);
      if (!status.url && ports.length > 0) {
        void this.monitorUrl(name, ports);
      }
    }

    await tryAutoOpen(serviceConfig, name, status.url, this.autoOpened);
    this.emit("stateChange", name, status);

    try {
      await serviceConfig.onReady?.();
    } catch (error) {
      // Log but don't fail the service start
      status.lastError = `onReady hook failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit("stateChange", name, status);
    }

    // Start crash monitor in background with current generation. Detached
    // Services are driven by the child `exit` event and their own output stream,
    // So the pane-based crash/output monitors don't apply (E4).
    const gen = this.monitorGenerations.get(name) ?? 0;
    if (!detached) {
      void this.monitorCrash(name, gen);

      // Start output monitor if onOutput is configured
      if (serviceConfig.onOutput) {
        void this.monitorOutput(name, gen);
      }
    }
  }

  /**
   * Stop a single service (serialized per service).
   */
  public async stopService(name: string): Promise<ServiceActionResult> {
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
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    // Detached services have no pane (E4).
    if (!status || (!serviceConfig?.detached && !paneTarget)) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Idempotent no-op: nothing to stop in these states (terminal or already
    // Stopping). Avoids a raw `Invalid state transition` over IPC on repeat calls.
    if (
      status.state === "stopped" ||
      status.state === "stopping" ||
      status.state === "error" ||
      status.state === "unavailable"
    ) {
      return { noop: true };
    }

    // Transition: ready/starting/restarting -> stopping
    status.state = transition(status.state, "stopping");
    this.emit("stateChange", name, status);

    // Abort any pending ready poll
    const controller = this.abortControllers.get(name);
    if (controller) {
      controller.abort();
    }

    // Invalidate any active crash/output monitors
    this.monitorGenerations.set(name, (this.monitorGenerations.get(name) ?? 0) + 1);

    const combined = serviceConfig?._combined;

    if (serviceConfig?.detached) {
      // Detached service: signal the process group (SIGTERM, then SIGKILL).
      await this.detachedRunner.stop(name);
    } else if (combined) {
      await this.stopCombinedService(name, serviceConfig, combined, paneTarget);
    } else {
      // Regular service: Ctrl-C and wait for exit
      await this.deps.sendCtrlC(paneTarget);
      await this.waitForPaneExit(paneTarget);
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

  /**
   * Stop one member of a combined docker group via `docker compose stop`, then —
   * once every sibling is stopped — Ctrl-C the owner's pane to tear down the
   * group's `docker compose up` (E10).
   */
  private async stopCombinedService(
    name: string,
    serviceConfig: ServiceConfig,
    combined: CombinedServiceMeta,
    paneTarget: string,
  ): Promise<void> {
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

    const allStopped = combined.allServices.every((sib) => {
      if (sib === name) {
        return true;
      }
      const sibStatus = this.statuses.get(sib);
      return !sibStatus || sibStatus.state === "stopped" || sibStatus.state === "error";
    });

    if (allStopped) {
      const ownerPane = this.resolveOwnerPane(combined, paneTarget);
      await this.deps.sendCtrlC(ownerPane);
      await this.waitForPaneExit(ownerPane);
    }
  }

  /**
   * Resolve the pane running the group's `docker compose up` — the owner's pane.
   * Falls back to the given pane if no owner is found.
   */
  private resolveOwnerPane(combined: CombinedServiceMeta, fallback: string): string {
    const owner = combined.allServices.find(
      (sib) => this.config.project.services[sib]?._combined?.isOwner,
    );
    return owner ? (this.paneMap[owner] ?? fallback) : fallback;
  }

  /**
   * Wait for pane process to exit with 5s timeout, force kill if needed.
   */
  private async waitForPaneExit(paneTarget: string): Promise<void> {
    const stopStart = Date.now();
    const STOP_TIMEOUT = 5000;
    let exited = false;

    while (Date.now() - stopStart < STOP_TIMEOUT) {
      const rootPid = await this.deps.panePid(paneTarget);
      const descendants = await this.deps.getDescendantPids(rootPid);
      if (descendants.length <= 1) {
        exited = true;
        break;
      }
      await sleep(200);
    }

    if (!exited) {
      const rootPid = await this.deps.panePid(paneTarget);
      const pids = await this.deps.getDescendantPids(rootPid);
      for (const pid of pids) {
        if (pid !== rootPid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  }

  /**
   * Restart a single service (serialized per service).
   */
  public async restartService(name: string): Promise<void> {
    return this.withServiceLock(name, async () => this.restartServiceInternal(name));
  }

  private async restartServiceInternal(name: string): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      throw new Error(`Unknown service: ${name}`);
    }

    const serviceConfig = this.config.project.services[name];
    const combined = serviceConfig?._combined;

    // For combined non-owner: use docker compose restart directly
    if (
      combined &&
      !combined.isOwner &&
      (status.state === "ready" || status.state === "starting")
    ) {
      // Abort any pending ready poll and invalidate active monitors so the old
      // Crash/output monitors don't survive alongside the new ones (C7).
      const controller = this.abortControllers.get(name);
      if (controller) {
        controller.abort();
      }
      this.monitorGenerations.set(name, (this.monitorGenerations.get(name) ?? 0) + 1);

      status.state = transition(status.state, "stopping");
      this.emit("stateChange", name, status);

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

      status.state = transition(status.state, "stopped");
      delete status.readySince;
      delete status.url;
      this.emit("stateChange", name, status);

      status.retryCount = 0;
      await this.startServiceInternal(name);
    } else {
      // Stop if running
      if (status.state === "ready" || status.state === "starting") {
        await this.stopServiceInternal(name);
      }

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
      // Re-check state after sleep (stopService may have changed it)
      if (status.state !== "ready") {
        return;
      }
      // Check if this monitor has been superseded by a newer generation
      if ((this.monitorGenerations.get(name) ?? 0) !== generation) {
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
        const rootPid = await this.deps.panePid(this.paneMap[name]);
        const descendants = await this.deps.getDescendantPids(rootPid);
        // If only shell PID left (no child), service has crashed
        crashed = descendants.length <= 1;
      }

      if (crashed) {
        // Re-check state and generation after async crash detection — stopService may have run
        if (status.state !== "ready" || (this.monitorGenerations.get(name) ?? 0) !== generation) {
          return;
        }
        await this.handleCrash(name, config, status);
        return;
      }
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

    const MAX_RETRIES = 5;
    let retries = 0;

    while (status.state === "ready" && !status.url && retries < MAX_RETRIES) {
      await sleep(2000);
      if (status.state !== "ready" || status.url) {
        return;
      }

      retries += 1;

      const result = await probePort(ports);
      if (result) {
        status.url = result;
        await tryAutoOpen(this.config.project.services[name], name, result, this.autoOpened);
        this.emit("stateChange", name, status);
        return;
      }
    }
  }
  /**
   * Monitor service output and call onOutput for each new line.
   */
  private async monitorOutput(name: string, generation: number): Promise<void> {
    const status = this.statuses.get(name);
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    if (!status || !serviceConfig?.onOutput || !paneTarget) {
      return;
    }

    // Capture initial baseline
    const baseline = await this.deps.capturePane(paneTarget, 500);
    let prevLines = baseline.split("\n");

    while (status.state === "ready") {
      await sleep(1000);
      if (status.state !== "ready" || (this.monitorGenerations.get(name) ?? 0) !== generation) {
        return;
      }

      const capture = await this.deps.capturePane(paneTarget, 500);
      const currentLines = capture.split("\n");
      const newLines = diffOutput(prevLines, currentLines);
      prevLines = currentLines;

      for (const line of newLines) {
        if (line.trim() !== "") {
          try {
            await serviceConfig.onOutput(line);
          } catch {
            // Swallow errors — onOutput must not crash the service
          }
        }
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

  public handleExecExited(
    service: string,
    _code: number,
    _signal: string | null,
    spawnError?: string,
  ): void {
    const status = this.statuses.get(service);
    if (!status) {
      return;
    }

    // Wrapper failed to spawn the command (E11): abort any in-flight start and
    // Fail fast with the spawn message instead of leaving the service stuck in
    // `starting` until the 60s ready timeout.
    if (spawnError !== undefined) {
      this.abortControllers.get(service)?.abort();
      this.monitorGenerations.set(service, (this.monitorGenerations.get(service) ?? 0) + 1);
      if (canTransition(status.state, "error")) {
        status.state = transition(status.state, "error");
      }
      status.lastError = spawnError;
      delete status.readySince;
      this.emit("stateChange", service, status);
      return;
    }

    if (status.state !== "ready") {
      return;
    }

    const config = this.config.project.services[service];
    const gen = this.monitorGenerations.get(service) ?? 0;

    // Invalidate current crash monitor generation to prevent double-trigger
    this.monitorGenerations.set(service, gen + 1);

    void this.handleCrash(service, config, status);
  }

  private async handleCrash(
    name: string,
    config: ServiceConfig,
    status: ServiceStatus,
  ): Promise<void> {
    const restartConfig = config.restart;
    if (restartConfig && status.retryCount < (restartConfig.maxRetries ?? 3)) {
      const gen = this.monitorGenerations.get(name) ?? 0;
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
          (this.monitorGenerations.get(name) ?? 0) !== gen ||
          status.state !== "restarting"
        ) {
          return;
        }

        // The restart must never reject out of handleCrash (a leaked rejection
        // Reaches Node and could kill the daemon — C2); on failure, go to error.
        try {
          // Wait for the crashed pane process (and any orphans) to fully exit
          // Before re-sending start keys, so the restart can't collide with a
          // Lingering process on the same port (C3). Pane-based services only;
          // Combined/docker services manage lifecycle via compose, not the pane.
          if (!config._combined && !config.detached) {
            await this.waitForPaneExit(this.paneMap[name]);
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
  sendKeys: (target: string, keys: string) => Promise<void>;
  sendCtrlC: (target: string) => Promise<void>;
  panePid: (target: string) => Promise<number>;
  detectPorts: (paneTarget: string) => Promise<number[]>;
  /** PID-based port detection for detached services (no pane) (E4). */
  detectPortsForPid?: (pid: number) => Promise<number[]>;
  capturePane: (target: string, lines: number) => Promise<string>;
  getDescendantPids: (rootPid: number) => Promise<number[]>;
  /** Record a spawned detached child PID for orphan protection (R10). */
  recordDetached?: (pid: number) => void;
  /** Drop a recorded detached child PID on clean stop/exit (R10). */
  removeDetached?: (pid: number) => void;
  /** Overridable spawn for detached children (tests inject a fake) (E4). */
  detachedSpawn?: SpawnFn;
  renameWindow: (target: string, name: string) => Promise<void>;
  getWindowName: (target: string) => Promise<string>;
  getWindowOption: (target: string, option: string) => Promise<string>;
  setWindowOption: (target: string, option: string, value: string) => Promise<void>;
  exec: (cmd: string, args: string[], cwd?: string) => Promise<void>;
  /** Pre-flight expected host ports; returns a conflict message or null (B2). */
  preflightPorts: (serviceConfig: ServiceConfig, projectDir: string) => Promise<string | null>;
  storeExecInfo: (service: string, info: ExecInfo) => void;
  sessionId: string;
  zapsCommand: string;
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
}

export { diffOutput };
