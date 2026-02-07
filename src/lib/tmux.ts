import { spawn } from "node:child_process";

async function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d));
    proc.stderr.on("data", (d: Buffer) => (stderr += d));
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`tmux ${args.join(" ")} failed: ${stderr.trim()}`));
      }
    });
  });
}

export async function listSessions(): Promise<string[]> {
  try {
    const out = await run(["list-sessions", "-F", "#{session_name}"]);
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function sendKeys(target: string, keys: string): Promise<void> {
  await run(["send-keys", "-t", target, keys, "Enter"]);
}
