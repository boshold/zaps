import { EventEmitter } from "node:events";

import type { DockerConfig, ResolvedConfig, ServiceConfig } from "#src/config/types.js";
import { buildDockerCommand, getContainerInfo } from "#src/lib/docker.js";
import { openInBrowser } from "#src/lib/open.js";
import { probePort } from "#src/lib/probe.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

import { buildServiceContext, formatEnvForShell, resolveEnv } from "./env.js";
import { buildRestartWithMap, reverseTopoSort, topoSort } from "./graph.js";
import { waitForReady } from "./ready.js";
import { createServiceStatus, transition } from "./state.js";
import type { ExecInfo, ReadyConfig, ReadyDeps, ServiceContext, ServiceStatus } from "./types.js";

type PaneMap = Record<string, string>;

/**
 * Find new lines between two pane captures using line-overlap diffing.
 * Finds the tail of `prev` that matches the head of `current`, returns lines after the overlap.
 */
function diffOutput(prev: string[], current: string[]): string[] {
  if (prev.length === 0) {
    return current;
  }

  // Try to find the longest tail of prev matching head of current
  for (let overlap = Math.min(prev.length, current.length); overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (prev[prev.length - overlap + i] !== current[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return current.slice(overlap);
    }
  }

  // No overlap found — return all current lines
  return current;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommand(config: ServiceConfig): string {
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
    return cmd();
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
  private statuses: Map<string, ServiceStatus>;
  private abortControllers: Map<string, AbortController>;
  private config: ResolvedConfig;
  private paneMap: PaneMap;
  private session: string;
  private shuttingDown = false;
  private deps: ServiceManagerDeps;
  private autoOpened = new Set<string>();
  private restartWithMap: Map<string, string[]>;
  private cascadingTriggers = new Set<string>();
  private monitorGenerations = new Map<string, number>();
  private originalWindowTitle: Promise<string>;
  private originalAutoRename: Promise<string | null>;
  // eslint-disable-next-line promise/prefer-await-to-then -- field initializer cannot use await
  private pendingRename: Promise<void> = Promise.resolve();

  constructor(config: ResolvedConfig, paneMap: PaneMap, deps: ServiceManagerDeps, session: string) {
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
      startService: async (name) => this.startService(name),
      restartService: async (name) => this.restartService(name),
      stopService: async (name) => this.stopService(name),
      isServiceRunning: (name) => this.statuses.get(name)?.state === "ready",
      openInBrowser: async (url) => openInBrowser(url),
    });
  }

  /**
   * Start all autostart services in topological order.
   */
  async startAll(): Promise<void> {
    const { services, hooks } = this.config.project;

    await fireHook(hooks?.onBeforeStart);

    // Filter to autostart services
    const autostartServices: Record<string, { dependsOn?: string[] }> = {};
    for (const [name, svc] of Object.entries(services)) {
      if (svc.flags?.start !== false) {
        autostartServices[name] = { dependsOn: svc.dependsOn };
      }
    }

    const levels = topoSort(autostartServices);

    for (const level of levels) {
      await Promise.all(
        level.map(async (name) => {
          try {
            await this.startService(name);
          } catch {
            // Let crash monitor handle retry; don't abort other services
          }
        }),
      );
    }

    await fireHook(hooks?.onStart);
  }

  /**
   * Stop all services in reverse topological order.
   */
  async stopAll(): Promise<void> {
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
   * Start a single service.
   */
  async startService(name: string): Promise<void> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    if (!serviceConfig || !paneTarget || !status) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Guard: skip if already starting or ready (prevents double-start races)
    if (status.state === "starting" || status.state === "ready") {
      return;
    }

    // Check dependencies are ready
    const deps = serviceConfig.dependsOn ?? [];
    for (const dep of deps) {
      const depStatus = this.statuses.get(dep);
      if (!depStatus || depStatus.state !== "ready") {
        throw new Error(`Dependency "${dep}" is not ready for service "${name}"`);
      }
    }

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

      // Detect ports — use docker-provided ports if available
      const ports = readyPorts.length > 0 ? readyPorts : await this.deps.detectPorts(paneTarget);

      // Update status
      status.state = transition(status.state, "ready");
      status.ports = ports;
      status.readySince = Date.now();

      const ctx = buildServiceContext(this.statuses, this.config.projectDir);
      await this.onServiceReady(name, serviceConfig, status, ports, ctx);
    } catch (error) {
      // If aborted during stop, don't transition to error
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
    const ctx = buildServiceContext(this.statuses, this.config.projectDir);
    const env = resolveEnv(serviceConfig.env, ctx);
    const resolvedCommand = resolveCommand(serviceConfig);
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
   * Stop a single service.
   */
  async stopService(name: string): Promise<void> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);

    if (!paneTarget || !status) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Transition: ready/starting -> stopping
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
        await this.deps.sendCtrlC(paneTarget);
        await this.waitForPaneExit(paneTarget);
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
   * Restart a single service.
   */
  async restartService(name: string): Promise<void> {
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
      // Abort any pending ready poll
      const controller = this.abortControllers.get(name);
      if (controller) {
        controller.abort();
      }

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
      await this.startService(name);
    } else {
      // Stop if running
      if (status.state === "ready" || status.state === "starting") {
        await this.stopService(name);
      }

      // Reset retry count
      status.retryCount = 0;

      // Start
      await this.startService(name);
    }

    // Cascade restart dependents
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
  async restartWithDockerOverrides(name: string, overrides: Partial<DockerConfig>): Promise<void> {
    const serviceConfig = this.config.project.services[name];
    if (!serviceConfig?.docker) {
      throw new Error(`Service "${name}" is not a docker service`);
    }

    const original = { ...serviceConfig.docker };
    Object.assign(serviceConfig.docker, overrides);
    try {
      await this.restartService(name);
    } finally {
      serviceConfig.docker = original;
    }
  }

  /**
   * Get status for a single service.
   */
  getStatus(name: string): ServiceStatus {
    const status = this.statuses.get(name);
    if (!status) {
      throw new Error(`Unknown service: ${name}`);
    }
    return status;
  }

  /**
   * Get all service statuses.
   */
  getAllStatuses(): ServiceStatus[] {
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

  handleExecExited(service: string, _code: number, _signal: string | null): void {
    const status = this.statuses.get(service);
    if (!status || status.state !== "ready") {
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
      status.state = transition(status.state, "restarting");
      status.retryCount += 1;
      delete status.readySince;
      this.emit("stateChange", name, status);

      const backoff = (restartConfig.backoff ?? 1000) * 2 ** (status.retryCount - 1);
      await sleep(backoff);

      // Transition: restarting -> starting (handled by startService)
      await this.startService(name);
      await this.cascadeRestart(name);
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
