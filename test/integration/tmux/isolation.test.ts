import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hasTmux } from "../helpers/skip.js";
import { createTmuxIsolation } from "../helpers/tmux-isolation.js";

function tmux(directory: string, socket: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: directory };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return execFileSync("tmux", ["-f", "/dev/null", "-L", socket, ...args], {
    env,
    encoding: "utf8",
  }).trim();
}

function start(directory: string, socket: string): void {
  tmux(directory, socket, [
    "new-session",
    "-d",
    "-s",
    "isolation",
    "--",
    "node",
    "-e",
    "setInterval(() => {}, 60_000)",
  ]);
}

describe.skipIf(!hasTmux())("integration tmux isolation", () => {
  it("passes the private socket directory to worker subprocesses and managed labels", () => {
    const directory = process.env.TMUX_TMPDIR;
    if (!directory) {
      throw new Error("Integration setup did not provide TMUX_TMPDIR");
    }
    start(directory, "zaps");
    try {
      const socket = tmux(directory, "zaps", ["display-message", "-p", "#{socket_path}"]);
      expect(path.relative(directory, socket)).not.toMatch(/^\.\./u);
      expect(path.basename(socket)).toBe("zaps");
    } finally {
      tmux(directory, "zaps", ["kill-server"]);
    }
  });

  it("isolates concurrent runs with identical labels and cleans only its own servers", () => {
    const first = createTmuxIsolation();
    const second = createTmuxIsolation();
    const labels = ["zaps", "zaps-test-shared"];
    try {
      expect(first.directory).not.toBe(second.directory);
      for (const label of labels) {
        start(first.directory, label);
        start(second.directory, label);
        const args = ["display-message", "-p", "#{socket_path}"];
        expect(tmux(first.directory, label, args)).not.toBe(tmux(second.directory, label, args));
      }

      first.cleanup();

      expect(fs.existsSync(first.directory)).toBe(false);
      for (const label of labels) {
        expect(tmux(second.directory, label, ["list-sessions", "-F", "#{session_name}"])).toBe(
          "isolation",
        );
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
