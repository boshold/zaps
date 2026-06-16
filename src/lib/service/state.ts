import type { ServiceState, ServiceStatus } from "./types.js";

const VALID_TRANSITIONS: Record<ServiceState, ServiceState[]> = {
  stopped: ["starting"],
  starting: ["ready", "error", "stopping"],
  ready: ["stopping", "restarting", "error"],
  stopping: ["stopped"],
  error: ["starting"],
  restarting: ["starting", "stopping", "error"],
  unavailable: [],
};

/**
 * Check if a state transition is valid.
 */
export function canTransition(from: ServiceState, to: ServiceState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Perform a state transition. Throws on invalid transitions.
 */
export function transition(from: ServiceState, to: ServiceState): ServiceState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} \u2192 ${to}`);
  }
  return to;
}

/**
 * Create a ServiceStatus with default values.
 */
export function createServiceStatus(name: string): ServiceStatus {
  return {
    name,
    state: "stopped",
    ports: [],
    retryCount: 0,
  };
}
