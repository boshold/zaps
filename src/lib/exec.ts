import type { ExecResult } from "#src/config/types.js";
import { OwnedCommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { getProcessEnv } from "#src/lib/env.js";

export interface ExecWithResultOptions {
  cwd: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ExecOptions extends ExecWithResultOptions {
  onLine: (line: string) => void;
}

export async function execCommandWithResult(
  cmd: string,
  opts: ExecWithResultOptions,
): Promise<ExecResult> {
  const runner = new ProcessRunner({
    onLines: () => {
      /* No-op */
    },
    onExit: () => {
      /* No-op */
    },
  });
  try {
    return await new OwnedCommandExecutor(runner).execute(cmd, {
      ...opts,
      env: { ...getProcessEnv(), ...opts.env },
    });
  } finally {
    await runner.dispose();
  }
}

export async function execCommand(cmd: string, opts: ExecOptions): Promise<void> {
  const result = await execCommandWithResult(cmd, opts);
  if (!result.success) {
    throw new Error(`Command failed with code ${result.exitCode}`);
  }
}
