import { randomUUID } from "node:crypto";

/**
 * Mint a unique id for one task run. Correlates the run's `task.start`/
 * `task.complete` events, its history record, and (Phase 5) its output buffer,
 * so concurrent runs of the same task `key` stay independent (Q12). Runs in the
 * normal daemon runtime (not a workflow script), so `randomUUID` is fine here.
 */
export function newRunId(): string {
  return `run_${randomUUID()}`;
}
