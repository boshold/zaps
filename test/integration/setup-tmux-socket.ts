import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { afterAll, expect } from "vitest";

// Short labels stay within Unix socket path limits on macOS.
function socketName(): string {
  const { testPath } = expect.getState();
  return testPath
    ? `file-${createHash("sha256").update(testPath).digest("hex").slice(0, 12)}`
    : `worker-${process.env.VITEST_POOL_ID ?? "0"}`;
}

const socket = socketName();
process.env.ZAPS_TMUX_SOCKET = socket;

afterAll(() => {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    /* Server already gone — nothing to reap */
  }
});
