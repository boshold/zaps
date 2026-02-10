import { EventEmitter } from "node:events";

import type { ResolvedConfig, ServiceConfig } from "../../config/types.js";
import type { ReadyDeps, ServiceStatus } from "./types.js";

import { buildServiceContext, formatEnvForShell, resolveEnv } from "./env.js";
import { reverseTopoSort, topoSort } from "./graph.js";
import { waitForReady } from "./ready.js";
import { createServiceStatus, transition } from "./state.js";

type PaneMap = Record<string, string>;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommand(config: ServiceConfig): string {
  const cmd = config.start ?? config.run;
  if (typeof cmd === "function") {
    return cmd();
  }
  return cmd ?? "";
}

async function fireHook(
  hook?: (...args: string[]) => void | Promise<void>,
  ...args: string[]
): Promise<void> {
  if (hook) {
    await hook(...args);
  }
}

export interface ServiceManagerEvents {
  stateChange: (name: string, status: ServiceStatus) => void;
}

export interface ServiceManagerDeps {
  sendKeys: (target: string, keys: string) => Promise<void>;
  sendCtrlC: (target: string) => Promise<void>;
  panePid: (target: string) => Promise<number>;
  detectPorts: (paneTarget: string) => Promise<number[]>;
  capturePane: (target: string, lines: number) => Promise<string>;
  getDescendantPids: (rootPid: number) => Promise<number[]>;
}

export class ServiceManager extends EventEmitter {
  private statuses: Map<string, ServiceStatus>;
  private abortControllers: Map<string, AbortController>;
  private config: ResolvedConfig;
  private paneMap: PaneMap;
  private shuttingDown = false;
  private deps: ServiceManagerDeps;

  constructor(config: ResolvedConfig, paneMap: PaneMap, deps: ServiceManagerDeps) {
    super();
    this.config = config;
    this.paneMap = paneMap;
    this.deps = deps;
    this.statuses = new Map<string, ServiceStatus>();
    this.abortControllers = new Map<string, AbortController>();

    // Initialize statuses for all services
    for (const name of Object.keys(config.project.services)) {
      this.statuses.set(name, createServiceStatus(name));
    }
  }

  /**
   * Start all autostart services in topological order.
   */
  async startAll(): Promise<void> {
    const { services, hooks } = this.config.project;

    // Filter to autostart services
    const autostartServices: Record<string, { dependsOn?: string[] }> = {};
    for (const [name, svc] of Object.entries(services)) {
      if (svc.autostart !== false) {
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
          if (status && status.state !== "stopped" && status.state !== "error") {
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
    this.shuttingDown = false;
  }

  /**
   * Start a single service.
   */
  async startService(name: string): Promise<void> {
    const serviceConfig = this.config.project.services[name];
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);
    const { hooks } = this.config.project;

    if (!serviceConfig || !paneTarget || !status) {
      throw new Error(`Unknown service: ${name}`);
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

    // Resolve env
    const ctx = buildServiceContext(this.statuses, this.config.projectDir);
    const env = resolveEnv(serviceConfig.env, ctx);

    // Build command
    const resolvedCommand = resolveCommand(serviceConfig);
    const envPrefix = formatEnvForShell(env);
    const command = envPrefix ? `${envPrefix} ${resolvedCommand}` : resolvedCommand;

    // Send to pane
    await this.deps.sendKeys(paneTarget, command);

    // Wait for ready
    try {
      const readyDeps: ReadyDeps = {
        detectPorts: this.deps.detectPorts,
        capturePane: this.deps.capturePane,
      };
      await waitForReady(serviceConfig.ready, paneTarget, controller.signal, readyDeps);

      // Detect ports
      const ports = await this.deps.detectPorts(paneTarget);

      // Update status
      status.state = transition(status.state, "ready");
      status.ports = ports;
      this.emit("stateChange", name, status);

      await fireHook(hooks?.onServiceStart, name);

      // Start crash monitor in background
      void this.monitorCrash(name);
    } catch (error) {
      // If aborted during stop, don't transition to error
      if (controller.signal.aborted) {
        return;
      }
      status.state = transition(status.state, "error");
      status.lastError = error instanceof Error ? error.message : String(error);
      this.emit("stateChange", name, status);
    }
  }

  /**
   * Stop a single service.
   */
  async stopService(name: string): Promise<void> {
    const paneTarget = this.paneMap[name];
    const status = this.statuses.get(name);
    const { hooks } = this.config.project;

    if (!paneTarget || !status) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Transition: ready/starting -> stopping
    status.state = transition(status.state, "stopping");
    this.emit("stateChange", name, status);

    // Send Ctrl-C
    await this.deps.sendCtrlC(paneTarget);

    // Abort any pending ready poll
    const controller = this.abortControllers.get(name);
    if (controller) {
      controller.abort();
    }

    // Poll for process exit with 5s timeout
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

    // Force kill if not exited
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

    // Transition: stopping -> stopped
    status.state = transition(status.state, "stopped");
    this.emit("stateChange", name, status);

    await fireHook(hooks?.onServiceStop, name);
  }

  /**
   * Restart a single service.
   */
  async restartService(name: string): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      throw new Error(`Unknown service: ${name}`);
    }

    // Stop if running
    if (status.state === "ready" || status.state === "starting") {
      await this.stopService(name);
    }

    // Reset retry count
    status.retryCount = 0;

    // Start
    await this.startService(name);
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
  private async monitorCrash(name: string): Promise<void> {
    const status = this.statuses.get(name);
    if (!status) {
      return;
    }
    const config = this.config.project.services[name];

    // Poll every 2s: check if process still alive
    while (status.state === "ready") {
      await sleep(2000);
      // Re-check state after sleep (stopService may have changed it)
      if (status.state !== "ready") {
        return;
      }

      const rootPid = await this.deps.panePid(this.paneMap[name]);
      const descendants = await this.deps.getDescendantPids(rootPid);

      // If only shell PID left (no child), service has crashed
      if (descendants.length <= 1) {
        const restartConfig = config.restart;
        if (restartConfig && status.retryCount < (restartConfig.maxRetries ?? 3)) {
          status.state = transition(status.state, "restarting");
          status.retryCount += 1;
          this.emit("stateChange", name, status);

          const backoff = (restartConfig.backoff ?? 1000) * 2 ** (status.retryCount - 1);
          await sleep(backoff);

          // Transition: restarting -> starting (handled by startService)
          await this.startService(name);
        } else {
          status.state = transition(status.state, "error");
          status.lastError = "Process exited unexpectedly";
          this.emit("stateChange", name, status);
        }
        return;
      }
    }
  }
}
