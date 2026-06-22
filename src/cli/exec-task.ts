import { spawn } from "node:child_process";
import net from "node:net";

import { socketPath } from "#src/daemon/lifecycle.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

interface TaskExecResult {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/** Split a stream into complete lines, buffering any trailing partial line. */
function makeLineEmitter(emit: (line: string) => void): {
  feed: (chunk: string) => void;
  flush: () => void;
} {
  let pending = "";
  return {
    feed(chunk: string): void {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
    },
    flush(): void {
      if (pending.length > 0) {
        emit(pending);
        pending = "";
      }
    },
  };
}

/** Open a persistent daemon connection for fire-and-forget streaming writes. */
async function connectStream(socketFile: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketFile);
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

/**
 * Hidden `exec-task` wrapper run inside a tmux pane by `tasks.runInPane`. It
 * resolves the task command from the daemon, runs it under `sh -c` (fish-safe),
 * tees stdout/stderr to the pane terminal AND streams each line back to the
 * daemon's `TaskOutputStore`, then reports its exit code so the daemon completes
 * the run. Output stays visible in the pane (Q13) and is retrievable post-mortem
 * via `tasks.output { runId }`.
 */
async function execTask(runId: string, sessionId: string): Promise<void> {
  const socket = socketPath();

  const res = await ipcRequest(socket, "exec-task.resolve", { runId }, undefined, sessionId).catch(
    () => null,
  );
  if (!res) {
    process.stderr.write("Error: Cannot connect to zaps daemon\n");
    process.exit(1);
  }
  if (res.error) {
    process.stderr.write(`Error: ${res.error}\n`);
    process.exit(1);
  }
  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  const info = res.result as TaskExecResult;

  const stream = await connectStream(socket).catch(() => null);
  if (!stream) {
    process.stderr.write("Error: Cannot stream task output to zaps daemon\n");
    process.exit(1);
  }
  // Drain daemon acks so the receive buffer never stalls fire-and-forget writes.
  stream.on("data", () => {
    /* Discard acks. */
  });
  stream.on("error", () => {
    /* Best-effort streaming — ignore transport errors. */
  });

  let seq = 0;
  const send = (method: string, params: unknown): void => {
    seq += 1;
    stream.write(`${JSON.stringify({ id: `et${seq}`, method, session: sessionId, params })}\n`);
  };
  const emitLine = (line: string): void => {
    send("exec-task.line", { runId, line });
  };
  const outEmitter = makeLineEmitter(emitLine);
  const errEmitter = makeLineEmitter(emitLine);

  const child = spawn("sh", ["-c", info.command], {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...info.env },
    cwd: info.cwd,
  });

  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(d);
    outEmitter.feed(d.toString());
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(d);
    errEmitter.feed(d.toString());
  });

  let finished = false;
  const finish = (code: number): void => {
    if (finished) {
      return;
    }
    finished = true;
    outEmitter.flush();
    errEmitter.flush();
    send("exec-task.exited", { runId, code });
    stream.end(() => process.exit(code));
    // Safety net if the socket never flushes/closes.
    setTimeout(() => process.exit(code), 1000).unref();
  };

  child.on("error", (err: Error) => {
    process.stderr.write(`Error: ${err.message}\n`);
    finish(127);
  });
  // Finish on 'close', not 'exit'. 'close' fires only after the child exited AND
  // All stdio streams closed — every stdout/stderr 'data' chunk delivered. 'exit'
  // Can precede the final 'data' (separate libuv events), so finishing on it would
  // Drop the tail line from both the pane tee and the daemon capture.
  child.on("close", (code) => {
    finish(code ?? 1);
  });
}

export { execTask };
