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
  const idle = new IdleTimer(IDLE_TIMEOUT_MS, () => {
    if (server.sessionCount === 0) {
      log("idle timeout, shutting down");
      shutdown();
    } else {
      idle.reset();
    }
  });

  function shutdown(): void {
    log("shutting down");
    idle.cancel();
    server.stop();
    removeSocket();
    removePid();
    fs.closeSync(logFile);
    process.exit(0);
  }

  server.onSessionChange = (count: number) => {
    if (count === 0) {
      idle.reset();
    } else {
      idle.cancel();
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await server.start(socketPath());
  log(`listening on ${socketPath()}`);
}

/**
 * Ensure daemon is running. If not, fork+detach a new one.
 * Returns when daemon socket is accepting connections.
 */
async function ensureDaemon(command: string): Promise<string> {
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

  const child = spawn(command, ["daemon", "run"], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(logFile);

  // Wait for socket to become connectable
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const alive = await pingSocket(sock);
    if (alive) {
      return sock;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Daemon failed to start within 5s");
}

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

export { ensureDaemon, runDaemon };
