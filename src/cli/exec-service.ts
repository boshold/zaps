import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

import { socketPath } from "#src/daemon/lifecycle.js";
import { execInfoSchema } from "#src/lib/backend/tmux/wrapper-schema.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { shellEscape } from "#src/lib/service/env.js";

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

async function readKeeperPid(gate: Duplex): Promise<number> {
  const observation = new AbortController();
  try {
    return await new Promise<number>((resolve, reject) => {
      let frame = "";
      const failed = () => reject(new Error("Wrapper keeper handshake failed"));
      const receive = (chunk: unknown) => {
        if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
          failed();
          return;
        }
        frame += chunk.toString();
        if (/^\d+\n$/u.test(frame)) {
          const pid = Number(frame.trim());
          if (Number.isSafeInteger(pid) && pid > 0) {
            resolve(pid);
            return;
          }
        }
        if (frame.length > 32 || frame.includes("\n")) {
          failed();
        }
      };
      const timer = setTimeout(failed, 2000);
      observation.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          gate.off("data", receive);
          gate.off("close", failed);
          gate.off("error", failed);
        },
        { once: true },
      );
      gate.on("data", receive);
      gate.once("close", failed);
      gate.once("error", failed);
    });
  } finally {
    observation.abort();
  }
}

async function execService(name: string, sessionId: string, executionId?: string): Promise<void> {
  const socket = socketPath();

  let result: ReturnType<typeof execInfoSchema.parse> | undefined = undefined;
  try {
    const res = await ipcRequest(
      socket,
      "exec-service.resolve",
      { service: name, ...(executionId === undefined ? {} : { executionId }) },
      undefined,
      sessionId,
    );
    if (res.error) {
      process.stderr.write(`Error: ${res.error}\n`);
      process.exit(1);
    }
    result = execInfoSchema.parse(res.result);
  } catch {
    process.stderr.write("Error: Cannot connect to zaps daemon\n");
    process.exit(1);
  }

  if (!result) {
    return;
  }

  // Detached → `sh` becomes a process-group leader so we can signal the whole
  // Group on stop (compound/env-prefixed commands aren't exec'd, so the real
  // Process is a grandchild of `sh` — E11). Do NOT unref: the wrapper must keep
  // Waiting on the child.
  const command = wrapCommand(result.command);
  const child = spawn(
    "sh",
    [
      "-c",
      result.trackOwnership
        ? `read -r ZAPS_LAUNCH <&3 || exit 127; sh -c 'read -r ZAPS_RELEASE <&4' 3<&- & ZAPS_KEEPER=$!; printf '%s\\n' "$ZAPS_KEEPER" >&3; read -r ZAPS_LAUNCH <&3 || exit 127; exec sh -c ${shellEscape(command)} 3<&- 4<&-`
        : command,
    ],
    {
      stdio: result.trackOwnership ? ["inherit", "inherit", "inherit", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...result.env },
      cwd: result.cwd,
      detached: true,
    },
  );

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
        {
          service: name,
          ...(executionId === undefined ? {} : { executionId }),
          code,
          signal,
          ...(spawnError === undefined ? {} : { spawnError }),
        },
        result?.trackOwnership ? 8000 : 1000,
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
  if (result.trackOwnership) {
    const { 3: gate, 4: keeper } = child.stdio;
    if (keeper instanceof Duplex) {
      keeper.on("error", () => notifyExit(127, null, "Wrapper keeper channel failed"));
    }
    if (gate instanceof Duplex) {
      gate.on("error", () => notifyExit(127, null, "Wrapper ownership channel failed"));
    }
    try {
      const response = await ipcRequest(
        socket,
        "exec-service.started",
        { service: name, executionId, pid: child.pid },
        2000,
        sessionId,
      );
      if (response.error || !(gate instanceof Duplex) || notified) {
        throw new Error("Wrapper ownership registration failed");
      }
      const keeperPid = readKeeperPid(gate);
      gate.write("start\n");
      const memberPid = await keeperPid;
      const registered = await ipcRequest(
        socket,
        "exec-service.started",
        { service: name, executionId, pid: child.pid, memberPid },
        2000,
        sessionId,
      );
      if (registered.error || notified) {
        throw new Error("Wrapper keeper registration failed");
      }
      gate.end("run\n");
    } catch {
      if (!notified && child.exitCode === null && child.signalCode === null) {
        forwardSignal("SIGKILL");
      }
      notifyExit(127, null, "Wrapper ownership registration failed");
    }
  }
}

export { execService, wrapCommand };
