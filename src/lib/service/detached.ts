import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** How long a stopped child gets to exit on SIGTERM before SIGKILL (E4). */
const STOP_GRACE_MS = 5000;

/** Recent lines retained per service for `ready.output` matching (E4). */
const MAX_RECENT_LINES = 500;

interface DetachedProcess {
  service: string;
  child: ChildProcess;
  pid: number;
  generation: number;
  stdoutRemainder: string;
  stderrRemainder: string;
  recentLines: string[];
  /** Set when a stop was requested — its exit must not trigger a crash. */
  stopping: boolean;
  /** Set once exit/error has been handled — guards the double-fire of both. */
  exited: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  onStopped?: () => void;
}

/**
 * Split a freshly received chunk into complete lines, carrying the trailing
 * partial line forward as the next remainder (so a line split across two chunks
 * is not emitted twice — per `40_data_model.md` stdout/stderrRemainder).
 */
function splitLines(remainder: string, chunk: Buffer): { lines: string[]; remainder: string } {
  const parts = (remainder + chunk.toString()).split("\n");
  const newRemainder = parts.pop() ?? "";
  return { lines: parts, remainder: newRemainder };
}

/**
 * Signal a child's whole process group (`-pid`), so grandchildren spawned by
 * `sh -c` are reached too. Falls back to the single PID if the group send fails
 * (e.g. the leader already gone).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Spawn signature — overridable in tests via {@link DetachedRunnerDeps.spawn}. */
export type SpawnFn = typeof spawn;

export interface DetachedSpawnOptions {
  service: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Generation captured at spawn — compared on exit to ignore stale children. */
  generation: number;
}

export interface DetachedRunnerDeps {
  /** Deliver complete log lines (buffer append + broadcast + onOutput hook). */
  onLines: (service: string, lines: string[]) => void;
  /**
   * Unexpected child exit. The caller compares `generation` against its current
   * value before treating it as a crash — a stop/restart bumps the generation,
   * so a stale child's exit is ignored (E4).
   */
  onExit: (service: string, generation: number) => void;
  /** Record a spawned child PID for orphan protection (R10). */
  record?: (pid: number) => void;
  /** Drop a recorded child PID on clean stop/exit (R10). */
  unrecord?: (pid: number) => void;
  /** Overridable spawn — defaults to `node:child_process` spawn. */
  spawn?: SpawnFn;
}

/**
 * Runs `detached: true` services pane-less (E4): spawns `sh -c <cmd>` in its own
 * process group, streams stdout/stderr line-split into the daemon's log path,
 * routes unexpected exits into the crash callback, and stops via process-group
 * signals (SIGTERM, then SIGKILL after a grace window). The child is NOT
 * `unref`'d — the daemon owns it (see Service Boundaries in `20_architecture.md`).
 */
export class DetachedRunner {
  private readonly procs = new Map<string, DetachedProcess>();
  private readonly deps: DetachedRunnerDeps;
  private readonly spawnFn: SpawnFn;

  public constructor(deps: DetachedRunnerDeps) {
    this.deps = deps;
    this.spawnFn = deps.spawn ?? spawn;
  }

  /**
   * Spawn a detached child for `service` and begin streaming its output.
   * Returns the child PID (or -1 if the spawn produced no pid).
   */
  public start(opts: DetachedSpawnOptions): number {
    const child = this.spawnFn("sh", ["-c", opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid ?? -1;
    const proc: DetachedProcess = {
      service: opts.service,
      child,
      pid,
      generation: opts.generation,
      stdoutRemainder: "",
      stderrRemainder: "",
      recentLines: [],
      stopping: false,
      exited: false,
    };
    this.procs.set(opts.service, proc);
    if (pid > 0) {
      this.deps.record?.(pid);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const result = splitLines(proc.stdoutRemainder, chunk);
      proc.stdoutRemainder = result.remainder;
      this.emitLines(proc, result.lines);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const result = splitLines(proc.stderrRemainder, chunk);
      proc.stderrRemainder = result.remainder;
      this.emitLines(proc, result.lines);
    });
    child.on("exit", () => {
      this.handleExit(proc);
    });
    child.on("error", () => {
      this.handleExit(proc);
    });
    return pid;
  }

  /**
   * Stop a detached service: SIGTERM the process group, escalating to SIGKILL
   * after the grace window. Resolves once the child exits (or immediately if it
   * is not running). The exit is flagged as a stop, so it never crash-restarts.
   */
  public async stop(service: string): Promise<void> {
    const proc = this.procs.get(service);
    if (!proc || proc.exited) {
      return;
    }
    proc.stopping = true;
    await new Promise<void>((resolve) => {
      proc.onStopped = resolve;
      signalGroup(proc.pid, "SIGTERM");
      const timer = setTimeout(() => {
        if (!proc.exited) {
          signalGroup(proc.pid, "SIGKILL");
        }
      }, STOP_GRACE_MS);
      timer.unref?.();
      proc.stopTimer = timer;
    });
  }

  /** Stop every running detached service (daemon shutdown / reload). */
  public async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map(async (service) => this.stop(service)));
  }

  /** Root PID for PID-based port detection, or -1 if not running. */
  public getPid(service: string): number {
    return this.procs.get(service)?.pid ?? -1;
  }

  /** Recent buffered lines — the `ready.output` source for detached services. */
  public getLines(service: string): string[] {
    return this.procs.get(service)?.recentLines ?? [];
  }

  public isRunning(service: string): boolean {
    const proc = this.procs.get(service);
    return proc !== undefined && !proc.exited;
  }

  private emitLines(proc: DetachedProcess, lines: string[]): void {
    if (lines.length === 0) {
      return;
    }
    proc.recentLines.push(...lines);
    if (proc.recentLines.length > MAX_RECENT_LINES) {
      proc.recentLines.splice(0, proc.recentLines.length - MAX_RECENT_LINES);
    }
    this.deps.onLines(proc.service, lines);
  }

  private handleExit(proc: DetachedProcess): void {
    if (proc.exited) {
      return;
    }
    proc.exited = true;

    // Flush any trailing partial line so the last output isn't dropped.
    const trailing: string[] = [];
    if (proc.stdoutRemainder) {
      trailing.push(proc.stdoutRemainder);
      proc.stdoutRemainder = "";
    }
    if (proc.stderrRemainder) {
      trailing.push(proc.stderrRemainder);
      proc.stderrRemainder = "";
    }
    this.emitLines(proc, trailing);

    if (proc.stopTimer) {
      clearTimeout(proc.stopTimer);
    }
    if (proc.pid > 0) {
      this.deps.unrecord?.(proc.pid);
    }
    if (this.procs.get(proc.service) === proc) {
      this.procs.delete(proc.service);
    }

    proc.onStopped?.();
    if (!proc.stopping) {
      this.deps.onExit(proc.service, proc.generation);
    }
  }
}
