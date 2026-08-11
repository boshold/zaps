import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

import {
  IdleTimer,
  acquireSpawnLock,
  daemonDir,
  isDaemonRunning,
  logPath,
  ownsPidFile,
  releaseSpawnLock,
  removePid,
  removeSocket,
  socketPath,
  writePid,
} from "#src/daemon/lifecycle.js";
import { DaemonServer } from "#src/daemon/server.js";
import { registerShutdownHook } from "#src/daemon/shutdown.js";

const IDLE_TIMEOUT_MS = 30_000;

/**
 * Working directory for the detached daemon. The invoking CLI's cwd is a project
 * dir that can be deleted while the daemon outlives it — on Linux every later
 * `spawn()` from a deleted cwd then fails with ENOENT (observed: a lingering
 * daemon whose tmux calls all died). Home (or `/`) is stable.
 */
function daemonSpawnCwd(): string {
  try {
    const home = os.homedir();
    return home && fs.existsSync(home) ? home : "/";
  } catch {
    return "/";
  }
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

/** Minimal surface `shutdownAll` needs from the daemon server. */
interface ShutdownTarget {
  list(): { id: string }[];
  destroy(id: string): Promise<void>;
  stop(): void;
}

/**
 * Build the single daemon teardown path shared by SIGTERM, SIGINT, the idle
 * timer, and the `daemon.shutdown` IPC method (D1). Destroys every session
 * best-effort — services stopped reverse-topo, panes killed and
 * `session.destroyed` broadcast by `Session.destroy()` — so one session failing
 * to destroy is logged and does NOT skip the remaining sessions or the file
 * cleanup. After all sessions are torn down it stops the socket server, then
 * runs `finalize` (idle cancel + ownership-checked socket/pid removal).
 *
 * Does NOT exit the process: callers exit *after* the returned promise resolves,
 * so an in-flight `daemon.shutdown` ACK can flush before the process dies. The
 * returned function is idempotent — a signal racing the IPC path is a no-op, so
 * sessions and files are never torn down twice.
 */
function createShutdownAll(
  server: ShutdownTarget,
  log: (msg: string) => void,
  finalize: () => void,
): () => Promise<void> {
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("shutting down");
    for (const { id } of server.list()) {
      try {
        await server.destroy(id);
      } catch (error) {
        log(`error destroying session ${id}: ${formatReason(error)}`);
      }
    }
    server.stop();
    finalize();
  };
}

/**
 * Run the daemon in the current process (called after fork+detach).
 */
async function runDaemon(): Promise<void> {
  // Socket selection is per-session only: a daemon started from inside a managed
  // Tmux must never inherit that socket and route every session's tmux calls to
  // It (50_api sanitization rule). `ensureDaemon` strips these too.
  delete process.env.ZAPS_TMUX_SOCKET;
  delete process.env.TMUX;

  // Same protection `ensureDaemon` gives the spawned path: never hold the
  // Invoking project dir open, since deleting it makes every later spawn() fail
  // With ENOENT. Matters for a manually started `zaps daemon run`.
  try {
    process.chdir(daemonSpawnCwd());
  } catch {
    // Unusable stable dir — keep the inherited cwd rather than refusing to boot.
  }

  writePid();

  const logFile = fs.openSync(logPath(), "a");
  const log = (msg: string) => {
    fs.writeSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`daemon started pid=${process.pid}`);

  const server = new DaemonServer();

  // Reap detached children orphaned by a previous daemon (crash/SIGKILL) before
  // Anything new starts, so leftover pane-less children don't hold ports (R10).
  server.reapDetachedOrphans();

  const idle = new IdleTimer(IDLE_TIMEOUT_MS, () => {
    if (server.sessionCount === 0) {
      log("idle timeout, shutting down");
      shutdownAndExit(); // eslint-disable-line no-use-before-define -- circular: idle/shutdownAndExit
    } else {
      idle.reset();
    }
  });

  // Shared teardown for signals + idle + `daemon.shutdown` IPC; the finalize
  // Closure cancels idle and removes only still-owned runtime files (D4).
  const shutdownAll = createShutdownAll(server, log, () => {
    idle.cancel();
    // Only remove runtime files we still own — a daemon that took over (pid file
    // Now names a different process) must not have its socket/pid unlinked (D4).
    if (ownsPidFile()) {
      removeSocket();
      removePid();
    }
  });

  // Close the log and exit. Kept separate from teardown so callers can flush an
  // IPC ACK between the two (the bun native binary drops a deferred timer when
  // The loop drains, so exit must be driven explicitly, not on a wall clock).
  // Idempotent: the IPC path schedules it via setImmediate while a racing signal
  // May also call it — only the first wins.
  let exited = false;
  const exitDaemon = () => {
    if (exited) {
      return;
    }
    exited = true;
    try {
      fs.closeSync(logFile);
    } catch {
      // Already closed.
    }
    process.exit(0);
  };

  // Signals + idle: tear down, then exit immediately.
  const shutdownAndExit = () => {
    void (async () => {
      try {
        await shutdownAll();
      } finally {
        exitDaemon();
      }
    })();
  };

  server.onSessionChange = (count: number) => {
    if (count === 0) {
      idle.reset();
    } else {
      idle.cancel();
    }
  };

  // `daemon.shutdown` IPC: run the teardown *inline* (so the response can ACK
  // Only after sockets/pids/panes are actually gone — deterministic), then exit
  // On the next tick so the ACK flushes to the caller first (D1).
  registerShutdownHook(async () => {
    await shutdownAll();
    setImmediate(exitDaemon);
  });

  process.on("SIGTERM", () => {
    shutdownAndExit();
  });
  process.on("SIGINT", () => {
    shutdownAndExit();
  });

  process.on("unhandledRejection", (reason: unknown) => {
    log(`unhandledRejection: ${formatReason(reason)}`);
  });
  process.on("uncaughtException", (err: Error) => {
    log(`uncaughtException: ${formatReason(err)}`);
  });

  await server.start(socketPath());
  log(`listening on ${socketPath()}`);

  // Arm the idle timer immediately so a daemon that never receives a session
  // Still exits after the idle window instead of living forever (D5).
  idle.reset();
}

/**
 * Poll the socket until it answers, the deadline (5s) passes, or a spawn error
 * is captured. `spawnFailure` carries an async `spawn` `error` event (E1).
 */
async function waitForSocketReady(
  sock: string,
  spawnFailure: { error?: Error },
  fileName: string,
): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnFailure.error) {
      throw new Error(`Failed to start daemon ('${fileName}'): ${spawnFailure.error.message}`);
    }
    const alive = await pingSocket(sock);
    if (alive) {
      return sock;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Daemon failed to start within 5s");
}

/**
 * Ensure daemon is running. If not, fork+detach a new one.
 * Returns when daemon socket is accepting connections.
 *
 * `command` is the spawnable argv `{ file, args }` (E1 — never a joined string,
 * which spawn would treat as a literal filename). The resolved invocation is
 * forwarded as `ZAPS_COMMAND` so the daemon builds correct per-service wrapper
 * commands even when zaps isn't on PATH as `zaps` (E2). The fork is guarded by
 * an O_EXCL spawn lock so concurrent CLIs don't both fork (D4).
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

  daemonDir(); // Ensure dir exists

  // Serialize the spawn decision: if another CLI already holds the lock, don't
  // Fork a second daemon — just wait for its socket to come up (D4).
  if (!acquireSpawnLock()) {
    return waitForSocketReady(sock, {}, command.file);
  }

  try {
    const logFile = fs.openSync(logPath(), "a");
    const zapsCommand = [command.file, ...command.args].join(" ");
    // Strip the caller's tmux context: the daemon picks a socket per session via
    // `tmuxFor(session.tmuxSocket)`, never from its own env (50_api).
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ZAPS_COMMAND: zapsCommand };
    delete childEnv.ZAPS_TMUX_SOCKET;
    delete childEnv.TMUX;
    const child = spawn(command.file, [...command.args, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", logFile, logFile],
      env: childEnv,
      cwd: daemonSpawnCwd(),
    });

    // Capture a spawn failure (e.g. ENOENT) so it surfaces as a clear error
    // Rather than crashing the process via an unhandled 'error' event (E1).
    const spawnFailure: { error?: Error } = {};
    child.on("error", (err: Error) => {
      spawnFailure.error = err;
    });
    child.unref();
    fs.closeSync(logFile);

    return await waitForSocketReady(sock, spawnFailure, command.file);
  } finally {
    releaseSpawnLock();
  }
}

export { createShutdownAll, ensureDaemon, runDaemon };
