import { randomUUID } from "node:crypto";

import type { ExecResult } from "#src/config/types.js";

import type { ProcessAuthority, ProcessRunner } from "./process-runner.js";

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
    const output: string[] = [];
    const { cwd } = options;
    const env = { ...options.env };
    return new Promise((resolve) => {
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void this.stop(unitId);
      };
      const unsubscribe = this.runner.subscribe((event) => {
        if (event.unitId !== unitId) {
          return;
        }
        if (event.kind === "output") {
          for (const rawLine of event.lines) {
            for (const line of rawLine.replace(/\r$/u, "").split("\r")) {
              output.push(line);
              options.onLine?.(line);
            }
          }
        } else if (event.kind === "exit") {
          unsubscribe();
          options.signal?.removeEventListener("abort", cancel);
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
        });
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) {
          cancel();
        }
      } catch (error) {
        unsubscribe();
        resolve({ success: false, exitCode: 1, output: [String(error)] });
      }
    });
  }
}
