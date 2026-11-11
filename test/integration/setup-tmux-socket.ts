import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  return testPath
    ? `file-${createHash("sha256").update(testPath).digest("hex").slice(0, 12)}`
    : `worker-${process.env.VITEST_POOL_ID ?? "0"}`;
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
