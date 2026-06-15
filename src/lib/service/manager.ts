import { EventEmitter } from "node:events";

import type {
  CombinedServiceMeta,
  DockerConfig,
  ResolvedConfig,
  ServiceConfig,
} from "#src/config/types.js";
import { buildDockerCommand, getContainerInfo } from "#src/lib/docker.js";
import { openInBrowser } from "#src/lib/open.js";
import { probePort } from "#src/lib/probe.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

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
    // For combined owner: build command with ALL services in the group
    if (config._combined?.isOwner) {
      const groupDocker: DockerConfig = {
        ...config.docker,
        service: config._combined.allServices,
      };
      return buildDockerCommand(groupDocker);
    }
    return buildDockerCommand(config.docker);
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
  composeFile?: string,
): string[] {
  const args = ["compose"];
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
  return {
    detectPorts: deps.detectPorts,
    capturePane: deps.capturePane,
    cwd: serviceConfig.cwd ?? projectDir,
    composeFile: serviceConfig.docker?.file,
    dockerStatus: getContainerInfo,
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
  private readonly deps: ServiceManagerDeps;
  private readonly autoOpened = new Set<string>();
  private readonly restartWithMap: Map<string, string[]>;
  private readonly cascadingTriggers = new Set<string>();
  private readonly monitorGenerations = new Map<string, number>();
  /** Per-service operation mutex: serializes start/stop/restart/rebuild (C8). */
  private readonly opLocks = new Map<string, Promise<void>>();
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

    // Initialize statuses for all services
    for (const [name, svc] of Object.entries(config.project.services)) {
      const status = createServiceStatus(name);
      if (svc.docker) {
        status.isDocker = true;
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
        this.emit("taskStart", key, tasks[key]?.name ?? key);
        const visited = new Set<string>();
        const results = new Map<string, "success" | "error">();
        const ok = await runTaskWithDeps(
          key,
          {
            tasks,
            statuses: this.statuses,
            projectDir: config.projectDir,
            services: config.project.services,
            onProgress: (taskKey, result) => {
              this.emit("taskComplete", taskKey, tasks[taskKey]?.name ?? taskKey, result);
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

  private async runStartAll(): Promise<void> {
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
      await Promise.all(
        level.map(async (name) => {
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
   * Stop all services in reverse topological order.
   */
  public async stopAll(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

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
    this.shuttingDown = false;
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
    return this.withServiceLock(name, async () => this.startServiceInternal(name, satisfiedDeps));
  }

  private async startServiceInternal(
    name: string,
    satisfiedDeps?: ReadonlySet<string>,
  ): Promise<ServiceActionResult> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    if (!serviceConfig || !paneTarget || !status) {
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

    await this.sendStartCommand(name, serviceConfig, paneTarget);

    // Wait for ready
    try {
      const readyDeps = buildReadyDeps(serviceConfig, this.deps, this.config.projectDir);
      const readyPorts = await waitForReady(
        resolveReadyConfig(serviceConfig),
        paneTarget,
        controller.signal,
        readyDeps,
      );

      // If aborted during ready wait (e.g. stopService called), exit silently
      if (controller.signal.aborted) {
        return { noop: false };
      }

      // Detect ports — use docker-provided ports if available
      const ports = readyPorts.length > 0 ? readyPorts : await this.deps.detectPorts(paneTarget);

      // Update status
      status.state = transition(status.state, "ready");
      status.ports = ports;
      status.readySince = Date.now();

      const ctx = buildServiceContext(
        this.statuses,
        this.config.projectDir,
        this.config.project.services,
      );
      await this.onServiceReady(name, serviceConfig, status, ports, ctx);
    } catch (error) {
      // If aborted during stop, don't transition to error
      if (controller.signal.aborted) {
        return { noop: false };
      }
      status.state = transition(status.state, "error");
      status.lastError = error instanceof Error ? error.message : String(error);
      delete status.readySince;
      this.emit("stateChange", name, status);
    }

    return { noop: false };
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
          buildDockerComposeArgs("start", name, serviceConfig.docker?.file),
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

  private async onServiceReady(
    name: string,
    serviceConfig: ServiceConfig,
    status: ServiceStatus,
    ports: number[],
    ctx: ServiceContext,
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

    // Start crash monitor in background with current generation
    const gen = this.monitorGenerations.get(name) ?? 0;
    void this.monitorCrash(name, gen);

    // Start output monitor if onOutput is configured
    if (serviceConfig.onOutput) {
      void this.monitorOutput(name, gen);
    }
  }

  /**
   * Stop a single service (serialized per service).
   */
  public async stopService(name: string): Promise<ServiceActionResult> {
    return this.withServiceLock(name, async () => this.stopServiceInternal(name));
  }

  private async stopServiceInternal(name: string): Promise<ServiceActionResult> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    if (!paneTarget || !status) {
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

    const combined = serviceConfig._combined;

    if (combined) {
      // Combined service: stop individual container via docker compose stop
      await this.deps.exec(
        "docker",
        buildDockerComposeArgs("stop", name, serviceConfig.docker?.file),
        serviceConfig.cwd ?? this.config.projectDir,
      );

      // If ALL siblings are now stopped, Ctrl-C the pane to clean up docker compose up
      const allStopped = combined.allServices.every((sib) => {
        if (sib === name) {
          return true;
        }
        const sibStatus = this.statuses.get(sib);
        return !sibStatus || sibStatus.state === "stopped" || sibStatus.state === "error";
      });

      if (allStopped) {
        // `docker compose up` for the whole group runs in the OWNER's pane —
        // Ctrl-C there, not the stopped member's (which may be an idle shell). E10
        const ownerPane = this.resolveOwnerPane(combined, paneTarget);
        await this.deps.sendCtrlC(ownerPane);
        await this.waitForPaneExit(ownerPane);
      }
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
        buildDockerComposeArgs("restart", name, serviceConfig.docker?.file),
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
    await this.deps.renameWindow(this.paneMap["@tui"], title);
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
          if (!config._combined) {
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
  taskComplete: (taskKey: string, taskName: string, result: "success" | "error") => void;
}

export interface ServiceManagerDeps {
  sendKeys: (target: string, keys: string) => Promise<void>;
  sendCtrlC: (target: string) => Promise<void>;
  panePid: (target: string) => Promise<number>;
  detectPorts: (paneTarget: string) => Promise<number[]>;
  capturePane: (target: string, lines: number) => Promise<string>;
  getDescendantPids: (rootPid: number) => Promise<number[]>;
  renameWindow: (target: string, name: string) => Promise<void>;
  getWindowName: (target: string) => Promise<string>;
  getWindowOption: (target: string, option: string) => Promise<string>;
  setWindowOption: (target: string, option: string, value: string) => Promise<void>;
  exec: (cmd: string, args: string[], cwd?: string) => Promise<void>;
  storeExecInfo: (service: string, info: ExecInfo) => void;
  sessionId: string;
  zapsCommand: string;
}

export { diffOutput };
