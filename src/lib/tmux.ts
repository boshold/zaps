import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { getEnv } from "./env.js";

function socketArgs(): string[] {
  const socket = getEnv("ZAPS_TMUX_SOCKET");
  return socket ? ["-L", socket] : [];
}

async function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", [...socketArgs(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
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

export async function showEnv(session: string, key: string): Promise<string | null> {
  try {
    const out = await run(["show-environment", "-t", session, key]);
    return out.replace(`${key}=`, "");
  } catch {
    return null;
  }
}

export interface PaneInfo {
  id: string;
  pid: number;
  width: number;
  height: number;
}

export async function listPanes(session: string, allWindows = false): Promise<PaneInfo[]> {
  const args = ["list-panes"];
  if (allWindows) {
    args.push("-s");
  }
  args.push("-t", session, "-F", "#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}");
  const out = await run(args);
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

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function sendKeys(target: string, keys: string): Promise<void> {
  await run(["send-keys", "-t", target, "-l", keys]);
  await run(["send-keys", "-t", target, "Enter"]);
}

export async function newSession(name: string, opts?: { x?: number; y?: number }): Promise<string> {
  const args = ["new-session", "-d", "-s", name];
  if (opts?.x) {
    args.push("-x", String(opts.x));
  }
  if (opts?.y) {
    args.push("-y", String(opts.y));
  }
  args.push("-P", "-F", "#{pane_id}");
  return run(args);
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
    args.push("-l", `${percent}%`);
  }
  args.push("-P", "-F", "#{pane_id}");
  return run(args);
}

export async function killPane(target: string): Promise<void> {
  await run(["kill-pane", "-t", target]);
}

/**
 * Block until someone runs `wait-for -S channel` for the same channel. Used by
 * the daemon to detect a pane command's completion without scraping its output:
 * the command signals a per-run channel when it exits and this resolves. tmux
 * queues an early `-S` (fired before any waiter), so there is no start race.
 */
export async function waitForChannel(channel: string): Promise<void> {
  await run(["wait-for", channel]);
}

/** Wake any client blocked on `channel` (and arm the next `wait-for` if none). */
export async function signalChannel(channel: string): Promise<void> {
  await run(["wait-for", "-S", channel]);
}

export async function panePid(target: string): Promise<number> {
  const out = await run(["display-message", "-p", "-t", target, "#{pane_pid}"]);
  return Number.parseInt(out, 10);
}

/** True if `target` is still a live tmux pane (false if it was killed/closed). */
export async function paneExists(target: string): Promise<boolean> {
  try {
    // A `display-message -t <id>` probe is NOT reliable: tmux exits 0 and echoes
    // The requested id back even for a dead pane whose session is gone, so it
    // Reports every pane as alive (the A4 staleness regression). Enumerate the
    // Live panes across the server instead and check real membership.
    const out = await run(["list-panes", "-a", "-F", "#{pane_id}"]);
    return out.split("\n").includes(target);
  } catch {
    return false;
  }
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

export async function removeEnv(session: string, key: string): Promise<void> {
  await run(["set-environment", "-u", "-t", session, key]);
}

export async function selectPane(target: string): Promise<void> {
  await run(["select-pane", "-t", target]);
}

export async function zoomPane(target: string): Promise<void> {
  await run(["select-pane", "-t", target]);
  await run(["resize-pane", "-Z", "-t", target]);
}

export async function getWindowName(target: string): Promise<string> {
  return run(["display-message", "-p", "-t", target, "#{window_name}"]);
}

export async function renameWindow(target: string, name: string): Promise<void> {
  await run(["rename-window", "-t", target, name]);
}

export async function getWindowOption(target: string, option: string): Promise<string> {
  return run(["show-window-option", "-v", "-t", target, option]);
}

export async function setWindowOption(
  target: string,
  option: string,
  value: string,
): Promise<void> {
  await run(["set-window-option", "-t", target, option, value]);
}

export interface DisplayPopupOptions {
  cwd?: string;
  command: string;
  title?: string;
  width?: string;
  height?: string;
  env?: Record<string, string>;
}

export async function displayPopup(opts: DisplayPopupOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["display-popup", "-EE"];
    if (opts.cwd) {
      args.push("-d", opts.cwd);
    }
    if (opts.width) {
      args.push("-w", opts.width);
    }
    if (opts.height) {
      args.push("-h", opts.height);
    }
    if (opts.title) {
      args.push("-T", opts.title);
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push("--", opts.command);

    const proc = spawn("tmux", [...socketArgs(), ...args], { stdio: "ignore" });
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Popup command failed with code ${code}`));
      }
    });
  });
}

export async function editPaneCapture(target: string, title: string): Promise<void> {
  const editor = getEnv("EDITOR") || "vim";
  const template = path.join(os.tmpdir(), "zaps-capture-XXXXXX");
  await displayPopup({
    command: `sh -c 'f=$(mktemp ${template}) && tmux capture-pane -t ${target} -p -S - > "$f" && ${editor} "$f"; rm -f "$f"'`,
    title,
    width: "90%",
    height: "90%",
  });
}
