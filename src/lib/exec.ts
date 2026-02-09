import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ExecOptions {
  cwd: string;
  onLine: (line: string) => void;
}

export function execCommand(cmd: string, opts: ExecOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], { cwd: opts.cwd });

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
