import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function testTmuxSocketPath(socket: string, root = process.env.ZAPS_TEST_TMUX_ROOT): string {
  if (!root) {
    throw new Error("Private tmux fixture root is not initialized");
  }
  const directory = path.join(root, `tmux-${os.userInfo().uid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, socket);
}

export function initializeTestTmuxServer(socket: string): void {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  execFileSync(
    "tmux",
    [
      "-f",
      "/dev/null",
      "-S",
      testTmuxSocketPath(socket),
      "start-server",
      ";",
      "set-option",
      "-s",
      "exit-empty",
      "off",
      ";",
      "set-option",
      "-g",
      "default-shell",
      "/bin/sh",
    ],
    { env, stdio: "ignore", timeout: 5000 },
  );
}
