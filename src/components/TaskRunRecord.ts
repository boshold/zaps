export interface TaskRunRecord {
  /**
   * Unique per run; correlates the run's start/complete events, history entry,
   * and (Phase 5) output buffer. A second run of the same `taskKey` gets a
   * distinct `runId`, so concurrent same-task runs no longer collide (Q12).
   */
  runId: string;
  taskKey: string;
  taskName: string;
  result: "success" | "error" | "running";
  timestamp: number;
  /** How the run was launched. Defaults to `background`; `pane` is set by `tasks.runInPane` (P04-T02). */
  mode?: "background" | "pane";
  /** Failure dismissed by the user (clears the sticky badge). */
  acknowledged?: boolean;
}
