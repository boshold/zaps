import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import type { ExecResult } from "#src/config/types.js";
import type { ExecutionEvent } from "#src/lib/backend/types.js";

import type { ProcessAuthority, ProcessRunner } from "./process-runner.js";

function captureOutput(onLine?: (line: string) => void) {
  const output: string[] = [];
  const inputs = { stdout: new PassThrough(), stderr: new PassThrough() };
  const closed = Object.values(inputs).map(async (input) => {
    const reader = createInterface({ input });
    reader.on("line", (line) => {
      output.push(line);
      onLine?.(line);
    });
    return new Promise<void>((resolve) => {
      reader.once("close", resolve);
    });
  });
  return {
    output,
    onChunk: (stream: "stdout" | "stderr", chunk: string | null) => {
      if (chunk === null) {
        inputs[stream].end();
      } else {
        inputs[stream].write(chunk);
      }
    },
    finish: async () => {
      for (const input of Object.values(inputs)) {
        input.end();
      }
      await Promise.all(closed);
    },
  };
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface CommandExecutor {
  execute(command: string, options: CommandOptions): Promise<ExecResult>;
}

export class OwnedCommandExecutor implements CommandExecutor {
  private readonly runner;
  private readonly authority;

  public constructor(runner: ProcessRunner, authority?: ProcessAuthority) {
    this.runner = runner;
    this.authority = authority;
  }

  private async stop(unitId: string): Promise<void> {
    const handle = this.runner.getHandle(unitId);
    if (handle) {
      try {
        await this.runner.stop(handle);
      } catch {
        /* Final exit carries cleanup diagnostics. */
      }
    }
  }

  public async execute(command: string, options: CommandOptions): Promise<ExecResult> {
    if (!this.runner.admits(this.authority)) {
      throw new Error("session_closing");
    }
    if (options.signal?.aborted) {
      return { success: false, exitCode: 1, output: ["Command cancelled"] };
    }
    const unitId = `command:${randomUUID()}`;
    const capture = captureOutput(options.onLine);
    const { output } = capture;
    const { cwd } = options;
    const env = { ...options.env };
    return new Promise((resolve) => {
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void this.stop(unitId);
      };
      const complete = async (event: Extract<ExecutionEvent, { kind: "exit" }>) => {
        await capture.finish();
        const aborted = cancelled || this.authority?.signal.aborted;
        for (const diagnostic of [
          event.spawnError,
          event.cleanupError,
          event.drainTimedOut ? "Output drain timed out" : undefined,
          event.signal ? `Command terminated by ${event.signal}` : undefined,
          aborted ? "Command cancelled" : undefined,
        ]) {
          if (diagnostic) {
            output.push(diagnostic);
          }
        }
        const success = event.code === 0 && !event.spawnError && !event.cleanupError && !aborted;
        resolve({ success, exitCode: success ? 0 : event.code || 1, output });
      };
      const unsubscribe = this.runner.subscribe((event) => {
        if (event.unitId === unitId && event.kind === "exit") {
          unsubscribe();
          options.signal?.removeEventListener("abort", cancel);
          void complete(event);
        }
      });
      try {
        this.runner.spawnOwned({
          unitId,
          generation: 1,
          command,
          cwd,
          env,
          authority: this.authority,
          onChunk: capture.onChunk,
        });
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) {
          cancel();
        }
      } catch (error) {
        unsubscribe();
        void complete({
          kind: "exit",
          unitId,
          generation: 1,
          code: 1,
          signal: null,
          spawnError: String(error),
        });
      }
    });
  }
}
