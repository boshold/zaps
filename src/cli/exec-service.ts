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

  const child = spawn("sh", ["-c", wrapCommand(result.command)], {
    stdio: "inherit",
    env: { ...process.env, ...result.env },
    cwd: result.cwd,
  });

  const forwardTerm = () => {
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", forwardTerm);

  child.on("exit", (code, signal) => {
    process.off("SIGTERM", forwardTerm);
    const exitCode = code ?? 1;
    const sig = signal ?? null;

    // Await exit notification with short timeout before exiting
    void (async () => {
      await ipcRequest(
        socket,
        "exec-service.exited",
        { service: name, code: exitCode, signal: sig },
        1000,
        sessionId,
      ).catch(() => {
        /* Best-effort — daemon may be gone */
      });
      process.exit(exitCode);
    })();
  });
}

export { execService, wrapCommand };
