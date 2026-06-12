import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    return path.join(xdg, "zaps");
  }
  return path.join(os.tmpdir(), `zaps-${os.userInfo().uid}`);
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
