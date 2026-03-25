import { spawn } from "node:child_process";

import { socketPath } from "#src/daemon/lifecycle.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

interface ExecResult {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

function wrapCommand(cmd: string): string {
  return /[|&;()`]/.test(cmd) ? cmd : `exec ${cmd}`;
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
