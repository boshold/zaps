import { abortable } from "#src/lib/backend/runtime/abortable.js";
import { topoSort } from "#src/lib/service/graph.js";
import type { ServiceActionResult, ServiceState, ServiceStatus } from "#src/lib/service/types.js";

import type { TaskServiceRequirements } from "./service-requirements.js";

type TaskServiceAction = "ok" | "wait" | "start" | "blocked";

interface TaskServicePlanEntry {
  name: string;
  state: ServiceState;
  action: TaskServiceAction;
  required: boolean;
  startable: boolean;
  /** Only on `blocked` entries. */
  reason?: string;
}

interface TaskPlanSummary {
  needsStart: boolean;
  autoStart: boolean;
  blocked: string[];
}

/** Structural subset of `ServiceManager` (a `Pick` would require `on`/`off` to return a full manager). */
interface TaskServiceManager {
  startService(name: string): Promise<ServiceActionResult>;
  getAllStatuses(): ServiceStatus[];
  on(event: "stateChange", listener: (name: string) => void): unknown;
  off(event: "stateChange", listener: (name: string) => void): unknown;
}

interface TaskServiceEvent {
  name: string;
  phase: "starting" | "waiting" | "ready";
}

interface EnsureTaskServicesOptions {
  start?: boolean;
  manager: TaskServiceManager;
  signal: AbortSignal;
  onEvent?: (event: TaskServiceEvent) => void;
}

const TASK_SERVICE_HEARTBEAT_MS = 30_000;

const FALLBACK_UNAVAILABLE_REASON = "not available on this machine";

class ServicesNotRunningError extends Error {
  public readonly code = "services_not_running";
  public readonly services: { name: string; state: ServiceState }[];

  public constructor(services: { name: string; state: ServiceState }[]) {
    super(
      `Required services not running: ${services.map((s) => `${s.name} (${s.state})`).join(", ")}`,
    );
    this.name = "ServicesNotRunningError";
    this.services = services;
  }
}

class ServiceUnavailableError extends Error {
  public readonly code = "service_unavailable";
  public readonly services: { name: string; reason: string }[];

  public constructor(services: { name: string; reason: string }[]) {
    super(
      `Required services unavailable: ${services.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
    );
    this.name = "ServiceUnavailableError";
    this.services = services;
  }
}

class ServiceStartFailedError extends Error {
  public readonly code = "service_start_failed";
  public readonly service: string;
  public readonly lastError: string | undefined;

  public constructor(service: string, lastError: string | undefined) {
    super(`Service '${service}' failed to start${lastError ? `: ${lastError}` : ""}`);
    this.name = "ServiceStartFailedError";
    this.service = service;
    this.lastError = lastError;
  }
}

const ACTION_BY_STATE: Record<ServiceState, TaskServiceAction> = {
  ready: "ok",
  starting: "wait",
  restarting: "wait",
  unavailable: "blocked",
  stopped: "start",
  error: "start",
  stopping: "start",
};

function planTaskServices(
  requirements: TaskServiceRequirements,
  statuses: readonly ServiceStatus[],
  serviceConfigs: Record<string, { dependsOn?: string[] }>,
  unavailable: ReadonlyMap<string, { reason: string }> = new Map(),
): TaskServicePlanEntry[] {
  const stateByName = new Map(statuses.map((s) => [s.name, s.state]));
  const configOf = (name: string) =>
    Object.hasOwn(serviceConfigs, name) ? serviceConfigs[name] : undefined;
  const autoStart = new Set(requirements.autoStartServices);
  const entries = new Map<string, TaskServicePlanEntry>();

  function entryFor(name: string, required: boolean, startable: boolean): TaskServicePlanEntry {
    // No status and no config: stripped optional (e.g. a cascaded group sibling).
    const state = stateByName.get(name) ?? (configOf(name) ? "stopped" : "unavailable");
    const action = ACTION_BY_STATE[state];
    const entry: TaskServicePlanEntry = { name, state, action, required, startable };
    if (action === "blocked") {
      entry.reason = unavailable.get(name)?.reason ?? FALLBACK_UNAVAILABLE_REASON;
    }
    return entry;
  }

  for (const name of requirements.services) {
    if (!entries.has(name)) {
      entries.set(name, entryFor(name, true, autoStart.has(name)));
    }
  }

  // Pull in non-ready transitive dependencies of every `start` entry.
  const visited = new Set<string>();
  function addDeps(name: string, startable: boolean): void {
    for (const dep of configOf(name)?.dependsOn ?? []) {
      const key = `${dep}\0${String(startable)}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const existing = entries.get(dep);
      if (existing) {
        existing.startable ||= startable;
      } else {
        const entry = entryFor(dep, false, startable);
        if (entry.action !== "ok") {
          entries.set(dep, entry);
        }
      }
      addDeps(dep, startable);
    }
  }
  for (const entry of entries.values()) {
    if (entry.action === "start") {
      addDeps(entry.name, entry.startable);
    }
  }

  const graph: Record<string, { dependsOn: string[] }> = {};
  for (const name of entries.keys()) {
    graph[name] = { dependsOn: (configOf(name)?.dependsOn ?? []).filter((d) => entries.has(d)) };
  }
  return topoSort(graph)
    .flat()
    .map((name) => entries.get(name))
    .filter((e) => e !== undefined);
}

function summarizePlan(plan: readonly TaskServicePlanEntry[]): TaskPlanSummary {
  const starts = plan.filter((e) => e.action === "start");
  return {
    needsStart: starts.length > 0,
    autoStart: starts.every((e) => e.startable),
    blocked: plan.filter((e) => e.action === "blocked").map((e) => e.name),
  };
}

function abortError(): Error {
  return new Error("Task service preparation aborted");
}

function statusOf(manager: TaskServiceManager, name: string): ServiceStatus | undefined {
  return manager.getAllStatuses().find((s) => s.name === name);
}

async function waitForReady(
  manager: TaskServiceManager,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const handlers = { change: (_name: string): void => undefined, abort: (): void => undefined };
    function cleanup(): void {
      manager.off("stateChange", handlers.change);
      signal.removeEventListener("abort", handlers.abort);
    }
    function settled(): boolean {
      const status = statusOf(manager, name);
      if (status?.state === "ready") {
        cleanup();
        resolve();
        return true;
      }
      if (!status || status.state === "error" || status.state === "stopped") {
        cleanup();
        reject(new ServiceStartFailedError(name, status?.lastError ?? status?.state));
        return true;
      }
      return false;
    }
    if (settled()) {
      return;
    }
    handlers.change = (changed) => {
      if (changed === name) {
        settled();
      }
    };
    handlers.abort = () => {
      cleanup();
      reject(abortError());
    };
    manager.on("stateChange", handlers.change);
    signal.addEventListener("abort", handlers.abort, { once: true });
  });
}

async function ensureTaskServices(
  plan: readonly TaskServicePlanEntry[],
  { start, manager, signal, onEvent }: EnsureTaskServicesOptions,
): Promise<{ started: string[] }> {
  const blocked = plan.filter((e) => e.action === "blocked");
  if (blocked.length > 0) {
    throw new ServiceUnavailableError(
      blocked.map((e) => ({ name: e.name, reason: e.reason ?? FALLBACK_UNAVAILABLE_REASON })),
    );
  }
  const starts = plan.filter((e) => e.action === "start");
  const permitted = start === true || (start === undefined && starts.every((e) => e.startable));
  if (starts.length > 0 && !permitted) {
    throw new ServicesNotRunningError(starts.map((e) => ({ name: e.name, state: e.state })));
  }
  if (signal.aborted) {
    throw abortError();
  }

  const started: string[] = [];
  let current: TaskServiceEvent | null = null;
  function emit(event: TaskServiceEvent): void {
    current = event.phase === "ready" ? null : event;
    onEvent?.(event);
  }
  const heartbeat = setInterval(() => {
    if (current) {
      onEvent?.(current);
    }
  }, TASK_SERVICE_HEARTBEAT_MS);

  try {
    for (const entry of plan) {
      if (entry.action === "wait") {
        emit({ name: entry.name, phase: "waiting" });
        await waitForReady(manager, entry.name, signal);
        emit({ name: entry.name, phase: "ready" });
      } else if (entry.action === "start") {
        emit({ name: entry.name, phase: "starting" });
        let noop = false;
        try {
          ({ noop } = await abortable(manager.startService(entry.name), signal, abortError()));
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          throw new ServiceStartFailedError(
            entry.name,
            error instanceof Error ? error.message : String(error),
          );
        }
        // Raced with another start: wait instead of failing on `starting`.
        await waitForReady(manager, entry.name, signal);
        if (!noop) {
          started.push(entry.name);
        }
        emit({ name: entry.name, phase: "ready" });
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  return { started };
}

export type {
  TaskServiceAction,
  TaskServicePlanEntry,
  TaskPlanSummary,
  TaskServiceManager,
  TaskServiceEvent,
  EnsureTaskServicesOptions,
};
export {
  TASK_SERVICE_HEARTBEAT_MS,
  ServicesNotRunningError,
  ServiceUnavailableError,
  ServiceStartFailedError,
  planTaskServices,
  summarizePlan,
  ensureTaskServices,
};
