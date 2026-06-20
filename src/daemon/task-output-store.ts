import { LogBuffer } from "./log-buffer.js";

/** Default per-run line cap (~5000 lines) and retained-run cap (N=20) — Q5. */
const DEFAULT_LINE_CAP = 5000;
const DEFAULT_MAX_RUNS = 20;

// One retained run's metadata + buffer. References `TaskRunResult` (exported
// Below — TS hoists type references, and exports are grouped last per lint).
interface TaskOutputEntry {
  runId: string;
  taskKey: string;
  result: TaskRunResult;
  startedAt: number;
  endedAt?: number;
  buffer: LogBuffer;
}

/** Terminal outcome of a run (`running` until the run settles). */
export type TaskRunResult = "success" | "error" | "running";

/** Public view of one retained run (the `tasks.output` response shape). */
export interface TaskOutputSnapshot {
  runId: string;
  taskKey: string;
  result: TaskRunResult;
  lines: string[];
  startedAt: number;
  endedAt?: number;
}

export interface TaskOutputStoreOptions {
  /** Max lines retained per run (older lines drop, ring-buffered). */
  lineCap?: number;
  /** Max concurrent retained runs before eviction kicks in. */
  maxRuns?: number;
}

/**
 * In-memory, daemon-side store of recent task-run output, keyed by `runId`.
 *
 * Each run gets a bounded `LogBuffer` (reused from the service log pipeline) plus
 * metadata. Retention is capped at N runs (Q5: 20) with **failure-preferential
 * eviction** — when over cap, the oldest non-error run is dropped first, so a
 * failure (the post-mortem signal) outlives later successes. In-memory only;
 * lost on daemon restart (acceptable — post-mortem is for the live session).
 */
export class TaskOutputStore {
  private readonly runs = new Map<string, TaskOutputEntry>();
  private readonly lineCap: number;
  private readonly maxRuns: number;

  public constructor(opts?: TaskOutputStoreOptions) {
    this.lineCap = opts?.lineCap ?? DEFAULT_LINE_CAP;
    this.maxRuns = opts?.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  /**
   * Begin retaining a run. Re-using a `runId` resets its buffer (a fresh run).
   * Insertion order is the eviction order, so this records "newest last".
   */
  public start(runId: string, taskKey: string, startedAt: number): void {
    // Delete first so a re-used runId moves to the end of the insertion order.
    this.runs.delete(runId);
    this.runs.set(runId, {
      runId,
      taskKey,
      result: "running",
      startedAt,
      buffer: new LogBuffer(this.lineCap),
    });
    this.evict();
  }

  /** Append one output line to a run's buffer (no-op if the run is unknown). */
  public append(runId: string, line: string): void {
    this.runs.get(runId)?.buffer.append(line);
  }

  /** Append many output lines to a run's buffer (no-op if the run is unknown). */
  public appendLines(runId: string, lines: string[]): void {
    this.runs.get(runId)?.buffer.appendLines(lines);
  }

  /** Mark a run settled with its outcome. Re-runs eviction (now failure-aware). */
  public finish(runId: string, result: "success" | "error", endedAt: number): void {
    const entry = this.runs.get(runId);
    if (!entry) {
      return;
    }
    entry.result = result;
    entry.endedAt = endedAt;
    this.evict();
  }

  /** Snapshot a retained run, or null when evicted/unknown (drives `not_found`). */
  public get(runId: string): TaskOutputSnapshot | null {
    const entry = this.runs.get(runId);
    if (!entry) {
      return null;
    }
    return {
      runId: entry.runId,
      taskKey: entry.taskKey,
      result: entry.result,
      lines: entry.buffer.snapshot(),
      startedAt: entry.startedAt,
      ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    };
  }

  /** Number of currently retained runs. */
  public get size(): number {
    return this.runs.size;
  }

  /** Drop runs beyond the cap, failures last (oldest non-error evicted first). */
  private evict(): void {
    while (this.runs.size > this.maxRuns) {
      const victim = this.pickVictim();
      if (victim === null) {
        return;
      }
      this.runs.delete(victim);
    }
  }

  /**
   * Choose the next run to evict, in priority order: oldest settled **success**,
   * then oldest settled **error**, then (only if everything is in-flight) oldest
   * **running**. So failures outlive successes, and an in-flight run is never
   * dropped while any settled run exists — a new run is retained even behind a
   * full set of old failures. Map iteration is insertion order (kept
   * chronological by `start()`), so the first match in each tier is the oldest.
   */
  private pickVictim(): string | null {
    let oldestSuccess: string | null = null;
    let oldestError: string | null = null;
    let oldestRunning: string | null = null;
    for (const [runId, entry] of this.runs) {
      if (entry.result === "success") {
        oldestSuccess ??= runId;
      } else if (entry.result === "error") {
        oldestError ??= runId;
      } else {
        oldestRunning ??= runId;
      }
    }
    return oldestSuccess ?? oldestError ?? oldestRunning;
  }
}
