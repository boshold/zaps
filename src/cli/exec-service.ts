import { spawn } from "node:child_process";

import { socketPath } from "#src/daemon/lifecycle.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

interface ExecResult {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/**
 * Prefix a command with `exec` so it replaces the wrapper shell (clean signal
 * delivery). Skipped when the command contains shell metacharacters (exec only
 * runs a single utility) or begins with a `NAME=value` env assignment — POSIX
 * `exec` would treat the assignment as the utility name and fail 127 (B1).
 */
function wrapCommand(cmd: string): string {
  const hasMetachars = /[|&;()`]/u.test(cmd);
  const hasEnvPrefix = /^\s*[A-Za-z_][A-Za-z0-9_]*=/u.test(cmd);
  return hasMetachars || hasEnvPrefix ? cmd : `exec ${cmd}`;
}

async function execService(name: string, sessionId: string): Promise<void> {
  const socket = socketPath();

  let result: ExecResult | null = null;
  try {
    const res = await ipcRequest(
      socket,
      "exec-service.resolve",
      { service: name },
      undefined,
      sessionId,
    );
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
    result = res.result as ExecResult;
  } catch {
    process.stderr.write("Error: Cannot connect to zaps daemon\n");
    process.exit(1);
  }

  // Detached → `sh` becomes a process-group leader so we can signal the whole
  // Group on stop (compound/env-prefixed commands aren't exec'd, so the real
  // Process is a grandchild of `sh` — E11). Do NOT unref: the wrapper must keep
  // Waiting on the child.
  const child = spawn("sh", ["-c", wrapCommand(result.command)], {
    stdio: "inherit",
    env: { ...process.env, ...result.env },
    cwd: result.cwd,
    detached: true,
  });

  // Forward termination to the whole process group so grandchildren die too (no
  // Orphans). The daemon stops a pane by sending Ctrl-C (SIGINT) to the pane's
  // Foreground group — which contains this wrapper but NOT the child (it has its
  // Own group via `detached: true`). Handle SIGINT as well as SIGTERM and forward
  // It to the child's group; otherwise SIGINT would kill only the wrapper, the
  // Child would be reparented to init, keep its port, and a restart would hit
  // EADDRINUSE (E11).
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Group gone or not permitted — fall back to a direct child signal.
      }
    }
    child.kill(signal);
  };
  const onSigterm = () => {
    forwardSignal("SIGTERM");
  };
  const onSigint = () => {
    forwardSignal("SIGINT");
  };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  let notified = false;
  const notifyExit = (code: number, signal: string | null, spawnError?: string): void => {
    if (notified) {
      return;
    }
    notified = true;
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    // Await exit notification with short timeout before exiting
    void (async () => {
      await ipcRequest(
        socket,
        "exec-service.exited",
        { service: name, code, signal, ...(spawnError === undefined ? {} : { spawnError }) },
        1000,
        sessionId,
      ).catch(() => {
        /* Best-effort — daemon may be gone */
      });
      process.exit(code);
    })();
  };

  // Spawn failure (e.g. bad cwd, unspawnable shell): report it so the daemon can
  // Set lastError and fail the service fast instead of leaving it in `starting`.
  child.on("error", (err: Error) => {
    notifyExit(127, null, err.message);
  });

  child.on("exit", (code, signal) => {
    notifyExit(code ?? 1, signal ?? null);
  });
}

export { execService, wrapCommand };
