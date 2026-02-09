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

export async function currentPaneId(): Promise<string> {
  return run(["display-message", "-p", "#{pane_id}"]);
}

export async function currentSession(): Promise<string> {
  return run(["display-message", "-p", "#{session_name}"]);
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

export async function newSession(name: string): Promise<string> {
  return run(["new-session", "-d", "-s", name, "-P", "-F", "#{pane_id}"]);
}

export async function newWindow(session: string): Promise<string> {
  return run(["new-window", "-t", session, "-d", "-P", "-F", "#{pane_id}"]);
}

export async function killSession(name: string): Promise<void> {
  await run(["kill-session", "-t", name]);
}

export async function splitPane(
  target: string,
  direction: "h" | "v",
  percent?: number,
): Promise<string> {
  const args = ["split-window", `-${direction}`, "-t", target];
  if (typeof percent === "number") {
    args.push("-p", String(percent));
  }
  args.push("-P", "-F", "#{pane_id}");
  return run(args);
}

export async function killPane(target: string): Promise<void> {
  await run(["kill-pane", "-t", target]);
}

export async function panePid(target: string): Promise<number> {
  const out = await run(["display-message", "-p", "-t", target, "#{pane_pid}"]);
  return Number.parseInt(out, 10);
}

export async function capturePane(target: string, lines = 100): Promise<string> {
  return run(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
}

export async function sendCtrlC(target: string): Promise<void> {
  await run(["send-keys", "-t", target, "C-c"]);
}

export async function setEnv(session: string, key: string, value: string): Promise<void> {
  await run(["set-environment", "-t", session, key, value]);
}

export async function selectPane(target: string): Promise<void> {
  await run(["select-pane", "-t", target]);
}

export interface PaneInfo {
  id: string;
  pid: number;
  width: number;
  height: number;
}

export async function listPanes(session: string): Promise<PaneInfo[]> {
  const out = await run([
    "list-panes",
    "-t",
    session,
    "-F",
    "#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}",
  ]);
  if (!out) {
    return [];
  }
  return out.split("\n").map((line) => {
    const [id, pid, width, height] = line.split(":");
    return {
      id,
      pid: Number.parseInt(pid, 10),
      width: Number.parseInt(width, 10),
      height: Number.parseInt(height, 10),
    };
  });
}
