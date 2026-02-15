import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ExecResult } from "#src/config/types.js";
import { getProcessEnv } from "#src/lib/env.js";

export interface ExecOptions {
  cwd: string;
  onLine: (line: string) => void;
  env?: Record<string, string>;
}

export async function execCommand(cmd: string, opts: ExecOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd: opts.cwd,
      ...(opts.env && { env: { ...getProcessEnv(), ...opts.env } }),
    });

    const stdoutRl = createInterface({ input: proc.stdout });
    const stderrRl = createInterface({ input: proc.stderr });

    stdoutRl.on("line", (line) => {
      opts.onLine(line);
    });
    stderrRl.on("line", (line) => {
      opts.onLine(line);
    });

    proc.on("close", (code) => {
      stdoutRl.close();
      stderrRl.close();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

export interface ExecWithResultOptions {
  cwd: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
}

export async function execCommandWithResult(
  cmd: string,
  opts: ExecWithResultOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd: opts.cwd,
      ...(opts.env && { env: { ...getProcessEnv(), ...opts.env } }),
    });

    const output: string[] = [];

    const stdoutRl = createInterface({ input: proc.stdout });
    const stderrRl = createInterface({ input: proc.stderr });

    stdoutRl.on("line", (line) => {
      output.push(line);
      opts.onLine?.(line);
    });
    stderrRl.on("line", (line) => {
      output.push(line);
      opts.onLine?.(line);
    });

    proc.on("close", (code) => {
      stdoutRl.close();
      stderrRl.close();
      const exitCode = code ?? 1;
      resolve({ success: exitCode === 0, exitCode, output });
    });
  });
}
