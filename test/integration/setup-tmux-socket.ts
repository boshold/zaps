import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterAll, expect } from "vitest";

/**
 * Give every integration FILE its own tmux server socket.
 *
 * With one shared server the suite raced against itself: the last `kill-session`
 * of one file tears the server down while the next file is creating its session
 * (`server exited unexpectedly`), and a client attached by one file resizes the
 * windows another file measures. A socket per file removes both — servers are
 * started on demand by the first command and exit when their last session dies.
 */
function socketName(): string {
  const { testPath } = expect.getState();
  if (!testPath) {
    // No file context (shouldn't happen in a per-file setup) — fall back to the
    // Worker id so concurrent workers still never share a server.
    return `zaps-test-w${process.env.VITEST_POOL_ID ?? "0"}`;
  }
  const stem = path
    .basename(testPath)
    .replace(/\.test\.ts$/u, "")
    .replace(/[^a-zA-Z0-9_-]/gu, "-");
  const dir = path.basename(path.dirname(testPath));
  return `zaps-test-${dir}-${stem}`;
}

const socket = socketName();
process.env.ZAPS_TMUX_SOCKET = socket;

afterAll(() => {
  // The file owns this server outright, so a kill-server is safe (and reaps any
  // Session a failed test left behind). Never touches the default server.
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    /* Server already gone — nothing to reap */
  }
});
