import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ENVIRONMENT_SNAPSHOT_VARIABLE,
  captureEnvironment,
  consumeEnvironmentSnapshot,
  loadProjectEnv,
  parseRequestContext,
  resolveEnvironment,
  runWithEnvironment,
  writeEnvironmentSnapshot,
} from "../../src/lib/request-context.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("request context", () => {
  it("validates an absolute cwd and string environment", () => {
    expect(parseRequestContext({ cwd: "/project", env: { API_URL: "test" } })).toEqual({
      cwd: "/project",
      env: { API_URL: "test" },
    });
    expect(() => parseRequestContext({ cwd: "relative", env: {} })).toThrow("must be absolute");
    expect(() => parseRequestContext({ cwd: "/project", env: { BAD: 1 } })).toThrow();
  });

  it("isolates concurrent process.env views", async () => {
    const values = await Promise.all([
      runWithEnvironment({ PROJECT: "a" }, async () => {
        await Promise.resolve();
        return process.env.PROJECT;
      }),
      runWithEnvironment({ PROJECT: "b" }, async () => {
        await Promise.resolve();
        return process.env.PROJECT;
      }),
    ]);
    expect(values).toEqual(["a", "b"]);
  });

  it("loads .env and lets the shell win", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-context-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, ".env"), "SHARED=project\nPROJECT_ONLY=yes\n", "utf8");

    expect(loadProjectEnv(dir)).toEqual({ SHARED: "project", PROJECT_ONLY: "yes" });
    expect(resolveEnvironment(dir, { SHARED: "shell", SHELL_ONLY: "yes" })).toEqual({
      SHARED: "shell",
      PROJECT_ONLY: "yes",
      SHELL_ONLY: "yes",
    });
  });

  it("consumes a private environment snapshot and keeps tmux routing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-context-"));
    dirs.push(dir);
    const filePath = writeEnvironmentSnapshot(dir, { PROJECT_VALUE: "snapshot" });
    expect(fs.statSync(filePath).mode % 0o1000).toBe(0o600);

    const original = captureEnvironment();
    try {
      process.env = {
        [ENVIRONMENT_SNAPSHOT_VARIABLE]: filePath,
        TERM: "tmux-256color",
        TMUX: "socket,1,0",
        TMUX_PANE: "%1",
        ZAPS_MANAGED_TMUX: "1",
        ZAPS_TMUX_SOCKET: "zaps",
      };
      consumeEnvironmentSnapshot();

      expect(captureEnvironment()).toEqual({
        PROJECT_VALUE: "snapshot",
        TERM: "tmux-256color",
        TMUX: "socket,1,0",
        TMUX_PANE: "%1",
        ZAPS_MANAGED_TMUX: "1",
        ZAPS_TMUX_SOCKET: "zaps",
      });
      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
