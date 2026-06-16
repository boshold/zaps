import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SPAWN_LOCK_STALE_MS = 10_000;

function getRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    return path.join(xdg, "zaps");
  }
  return path.join(os.tmpdir(), `zaps-${os.userInfo().uid}`);
}

/** True if a spawn lock is orphaned (old mtime, or its pid is gone/garbage). */
function isLockStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > SPAWN_LOCK_STALE_MS) {
      return true;
    }
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isNaN(pid)) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    // Can't stat — treat as gone so a fresh acquire can proceed.
    return true;
  }
}

/** Create the lock file with O_EXCL; false if it already exists. */
function createLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export function daemonDir(): string {
  const dir = getRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function socketPath(): string {
  const override = process.env.ZAPS_SOCKET_PATH;
  if (override) {
    return override;
  }
  return path.join(daemonDir(), "daemon.sock");
}

export function pidPath(): string {
  return path.join(daemonDir(), "daemon.pid");
}

export function logPath(): string {
  return path.join(daemonDir(), "daemon.log");
}

export function spawnLockPath(): string {
  return path.join(daemonDir(), "spawn.lock");
}

export function writePid(): void {
  fs.writeFileSync(pidPath(), String(process.pid), "utf8");
}

export function readPid(): number | null {
  try {
    const raw = fs.readFileSync(pidPath(), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePid(): void {
  try {
    fs.unlinkSync(pidPath());
  } catch {
    // Already gone
  }
}

export function removeSocket(): void {
  try {
    fs.unlinkSync(socketPath());
  } catch {
    // Already gone
  }
}

/**
 * Check if a daemon process is alive by PID.
 */
export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not found — stale PID
    removePid();
    removeSocket();
    return false;
  }
}

export function releaseSpawnLock(): void {
  try {
    fs.unlinkSync(spawnLockPath());
  } catch {
    // Already gone
  }
}

/**
 * Acquire the daemon-spawn mutex via an O_EXCL lock file (D4). Returns false if
 * another process holds a live lock; breaks and re-acquires a stale lock once.
 */
export function acquireSpawnLock(): boolean {
  const lockPath = spawnLockPath();
  if (createLock(lockPath)) {
    return true;
  }
  if (isLockStale(lockPath)) {
    releaseSpawnLock();
    return createLock(lockPath);
  }
  return false;
}

/** True if the pid file still names this process (it hasn't been taken over). */
export function ownsPidFile(): boolean {
  return readPid() === process.pid;
}

/**
 * Auto-shutdown timer. Resets on activity. Fires callback after idle timeout.
 */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;
  private readonly onIdle: () => void;

  public constructor(timeoutMs: number, onIdle: () => void) {
    this.timeoutMs = timeoutMs;
    this.onIdle = onIdle;
  }

  public reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.onIdle();
    }, this.timeoutMs);
  }

  public cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
