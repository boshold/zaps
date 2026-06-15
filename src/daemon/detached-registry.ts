import fs from "node:fs";
import path from "node:path";

import { daemonDir } from "./lifecycle.js";

/** A `/proc`-derived identity used to detect PID reuse before reaping (R10). */
interface ProcInfo {
  /** `/proc/<pid>/stat` field 22 (starttime) — stable for a process's lifetime. */
  startTime: string;
  /** `/proc/<pid>/cmdline`, NUL-separated args joined with spaces. */
  cmdline: string;
}

interface DetachedEntry {
  pid: number;
  startTime: string;
  cmdline: string;
}

/**
 * Parse `/proc/<pid>/stat` + `/proc/<pid>/cmdline` for the reuse-safe identity.
 * Returns null on any platform without `/proc` or when the pid is gone, so the
 * registry degrades to "don't reap" rather than risk killing an unrelated pid.
 */
function defaultReadProcInfo(pid: number): ProcInfo | null {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // `comm` (field 2) may contain spaces and parens — parse after the final ')'.
    const close = stat.lastIndexOf(") ");
    if (close === -1) {
      return null;
    }
    // After comm: index 0 = state (field 3); starttime is field 22 → index 19.
    const fields = stat.slice(close + 2).split(" ");
    const startTime = fields[19] ?? "";
    if (!startTime) {
      return null;
    }
    const cmdlineRaw = fs.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8");
    // `/proc/<pid>/cmdline` separates args with NUL; join them for a stable key.
    const cmdline = cmdlineRaw.split(String.fromCharCode(0)).join(" ").trim();
    return { startTime, cmdline };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDetachedEntry(value: unknown): value is DetachedEntry {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    typeof value.startTime === "string" &&
    typeof value.cmdline === "string"
  );
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

export interface DetachedRegistryDeps {
  /** Bookkeeping file path (defaults to `<runtimeDir>/detached.json`). */
  filePath: string;
  /** Read a live PID's start-time + cmdline, or null when unavailable. */
  readProcInfo: (pid: number) => { startTime: string; cmdline: string } | null;
  /** Signal a process (group) — defaults to `process.kill`. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Tracks PIDs of detached children in `detached.json` so a daemon crash/SIGKILL
 * never leaves orphaned, port-holding children (R10). Detached children run in
 * their own process group precisely so they survive parent signals, which is
 * exactly why they must be reaped explicitly on the next daemon startup.
 */
export class DetachedRegistry {
  private readonly overrides: Partial<DetachedRegistryDeps>;
  /** Lazily resolved so construction never touches the filesystem (`daemonDir`). */
  private resolved: DetachedRegistryDeps | null = null;

  public constructor(deps?: Partial<DetachedRegistryDeps>) {
    this.overrides = deps ?? {};
  }

  private get deps(): DetachedRegistryDeps {
    this.resolved ??= {
      filePath: this.overrides.filePath ?? path.join(daemonDir(), "detached.json"),
      readProcInfo: this.overrides.readProcInfo ?? defaultReadProcInfo,
      kill: this.overrides.kill ?? defaultKill,
    };
    return this.resolved;
  }

  /** Record a freshly spawned child, capturing its start-time/cmdline identity. */
  public record(pid: number): void {
    const data = this.load();
    const info = this.deps.readProcInfo(pid);
    data[String(pid)] = {
      pid,
      startTime: info?.startTime ?? "",
      cmdline: info?.cmdline ?? "",
    };
    this.save(data);
  }

  /** Drop a child from the file on clean stop/exit. */
  public remove(pid: number): void {
    const key = String(pid);
    const data = this.load();
    if (!(key in data)) {
      return;
    }
    const next: Record<string, DetachedEntry> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k !== key) {
        next[k] = v;
      }
    }
    this.save(next);
  }

  /**
   * On daemon startup: SIGTERM the process group of every leftover entry whose
   * live start-time AND cmdline still match the record (PID-reuse-safe), then
   * clear the file. Mismatched/dead entries are dropped without signalling.
   */
  public reapOrphans(): void {
    const data = this.load();
    for (const entry of Object.values(data)) {
      const info = this.deps.readProcInfo(entry.pid);
      if (info && info.startTime === entry.startTime && info.cmdline === entry.cmdline) {
        try {
          // Negative pid → whole process group, matching the spawn-time group.
          this.deps.kill(-entry.pid, "SIGTERM");
        } catch {
          // Already gone — best-effort.
        }
      }
    }
    this.save({});
  }

  private load(): Record<string, DetachedEntry> {
    const result: Record<string, DetachedEntry> = {};
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(fs.readFileSync(this.deps.filePath, "utf8"));
    } catch {
      // Missing or corrupt file — start from empty (best-effort, R10).
      return result;
    }
    if (!isRecord(parsed)) {
      return result;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (isDetachedEntry(value)) {
        result[key] = value;
      }
    }
    return result;
  }

  private save(data: Record<string, DetachedEntry>): void {
    try {
      fs.writeFileSync(this.deps.filePath, JSON.stringify(data), "utf8");
    } catch {
      // Best-effort — orphan protection must never block start/stop.
    }
  }
}
