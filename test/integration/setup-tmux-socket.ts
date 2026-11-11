import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect } from "vitest";

import {
  cleanupTestTmuxServers,
  initializeTestTmuxServer,
  testTmuxSocketPath,
} from "./helpers/tmux-server.js";

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
const previousEnvironment = {
  TMPDIR: process.env.TMPDIR,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  ZAPS_TEST_TMUX_ROOT: process.env.ZAPS_TEST_TMUX_ROOT,
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zt-"));
process.env.TMPDIR = root;
process.env.TMUX_TMPDIR = root;
process.env.ZAPS_TEST_TMUX_ROOT = root;
process.env.ZAPS_TMUX_SOCKET = socket;
const ownedSockets = [testTmuxSocketPath(socket, root), testTmuxSocketPath("zaps", root)];

afterAll(async () => {
  try {
    await cleanupTestTmuxServers(ownedSockets, root);
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
});

if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0) {
  initializeTestTmuxServer(socket);
}
