import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

import {
  IdleTimer,
  daemonDir,
  isDaemonRunning,
  logPath,
  removePid,
  removeSocket,
  socketPath,
  writePid,
} from "#src/daemon/lifecycle.js";
import { DaemonServer } from "#src/daemon/server.js";

const IDLE_TIMEOUT_MS = 30_000;

async function pingSocket(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(sock);
    client.on("connect", () => {
      const req = JSON.stringify({ id: "ping0", method: "daemon.ping" });
      client.write(`${req}\n`);
    });
    client.on("data", () => {
      client.destroy();
      resolve(true);
    });
    client.on("error", () => {
      resolve(false);
    });
    setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
  });
}

/**
 * Format a rejection reason or thrown value for logging, preferring an
 * Error stack and falling back to a string representation.
 */
function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

/**
 * Run the daemon in the current process (called after fork+detach).
 */
async function runDaemon(): Promise<void> {
  writePid();

  const logFile = fs.openSync(logPath(), "a");
  const log = (msg: string) => {
    fs.writeSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`daemon started pid=${process.pid}`);

  const server = new DaemonServer();

  function shutdown(): void {
    log("shutting down");
    idle.cancel(); // eslint-disable-line no-use-before-define -- circular: shutdown/idle
    server.stop();
    removeSocket();
    removePid();
    fs.closeSync(logFile);
    process.exit(0);
  }

  const idle = new IdleTimer(IDLE_TIMEOUT_MS, () => {
    if (server.sessionCount === 0) {
      log("idle timeout, shutting down");
      shutdown();
    } else {
      idle.reset();
    }
  });

  server.onSessionChange = (count: number) => {
    if (count === 0) {
      idle.reset();
    } else {
      idle.cancel();
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.on("unhandledRejection", (reason: unknown) => {
    log(`unhandledRejection: ${formatReason(reason)}`);
  });
  process.on("uncaughtException", (err: Error) => {
    log(`uncaughtException: ${formatReason(err)}`);
  });

  await server.start(socketPath());
  log(`listening on ${socketPath()}`);
}

/**
 * Ensure daemon is running. If not, fork+detach a new one.
 * Returns when daemon socket is accepting connections.
 *
 * `command` is the spawnable argv `{ file, args }` (E1 — never a joined string,
 * which spawn would treat as a literal filename). The resolved invocation is
 * forwarded as `ZAPS_COMMAND` so the daemon builds correct per-service wrapper
 * commands even when zaps isn't on PATH as `zaps` (E2).
 */
async function ensureDaemon(command: { file: string; args: string[] }): Promise<string> {
  const sock = socketPath();

  if (isDaemonRunning()) {
    // Verify socket is actually connectable
    const alive = await pingSocket(sock);
    if (alive) {
      return sock;
    }
    // Stale — clean up and re-launch
    removeSocket();
    removePid();
  }

  // Fork daemon as detached child
  daemonDir(); // Ensure dir exists
  const logFile = fs.openSync(logPath(), "a");

  const zapsCommand = [command.file, ...command.args].join(" ");
  const child = spawn(command.file, [...command.args, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
    env: { ...process.env, ZAPS_COMMAND: zapsCommand },
  });

  // Capture a spawn failure (e.g. ENOENT) so it surfaces as a clear error
  // Rather than crashing the process via an unhandled 'error' event (E1).
  const spawnFailure: { error?: Error } = {};
  child.on("error", (err: Error) => {
    spawnFailure.error = err;
  });
  child.unref();
  fs.closeSync(logFile);

  // Wait for socket to become connectable
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnFailure.error) {
      throw new Error(`Failed to start daemon ('${command.file}'): ${spawnFailure.error.message}`);
    }
    const alive = await pingSocket(sock);
    if (alive) {
      return sock;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Daemon failed to start within 5s");
}

export { ensureDaemon, runDaemon };
