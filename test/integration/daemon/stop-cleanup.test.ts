/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ipcRequest } from "#src/lib/ipc/client.js";

import { waitForServiceState, writeTestConfig } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasBinary, hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

const execFileAsync = promisify(execFile);
const binaryPath = path.resolve("dist/zaps");

/** Poll until `predicate` is true or the deadline passes. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- polling loop */
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /* eslint-enable no-await-in-loop */
  return predicate();
}

/** True if a TCP connection to localhost:port is refused (nothing listening). */
async function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, "127.0.0.1");
    sock.on("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => {
      resolve(true);
    });
    setTimeout(() => {
      sock.destroy();
      resolve(true);
    }, 1000);
  });
}

/** List every pane id across the test tmux server. */
function listAllPanes(): string[] {
  try {
    const result = execFileSync(
      "tmux",
      ["-L", testTmuxSocket() ?? "zaps-test", "list-panes", "-a", "-F", "#{pane_id}"],
      { encoding: "utf8" },
    );
    return result.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

// `zaps daemon stop` must tear down everything a `zaps up` created: every
// Session destroyed (services stopped, panes killed), then socket + pid files
// Removed (D1). Otherwise orphaned panes/services leak and the next `zaps up`
// Hits port conflicts. Requires the native binary and a real tmux server.
describe.skipIf(!hasBinary() || !hasTmux())("zaps daemon stop cleanup", () => {
  let tmux: TestSession;
  let runtimeDir: string;
  let tmpDir: string;
  let sock: string;
  let pidFile: string;
  let port: number;
  let webPane: string | undefined;
  let stopStdout = "";

  beforeAll(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-stop-rt-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-stop-proj-"));
    tmux = await createTestSession();
    port = await getFreePort();
    const configPath = writeTestConfig(tmpDir, port);

    sock = path.join(runtimeDir, "zaps", "daemon.sock");
    pidFile = path.join(runtimeDir, "zaps", "daemon.pid");

    const childEnv = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      ZAPS_TMUX_SOCKET: testTmuxSocket() ?? "zaps-test",
    };

    // Fork a real background daemon (isolated runtime dir + tmux server).
    await execFileAsync(binaryPath, ["daemon", "start"], { env: childEnv });
    await waitUntil(() => fs.existsSync(sock));

    // Stand up a session with one ready service — the `zaps up` equivalent.
    const createRes = await ipcRequest(sock, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    const data = createRes.result as { paneMap: Record<string, string> };
    webPane = data.paneMap.web;
    const sid = (createRes.result as { id: string }).id;
    await waitForServiceState(sock, sid, "web", "ready");

    // Stop the daemon and capture the reported counts.
    const { stdout } = await execFileAsync(binaryPath, ["daemon", "stop"], { env: childEnv });
    stopStdout = stdout;

    // Teardown is deferred ~100ms after the ack — wait for the files to vanish.
    await waitUntil(() => !fs.existsSync(sock) && !fs.existsSync(pidFile));
  });

  afterAll(async () => {
    await tmux.cleanup();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports the destroyed session and service counts", () => {
    expect(stopStdout.trim()).toBe("Stopped 1 session(s), 1 service(s).");
  });

  it("removes the socket and pid files", () => {
    expect(fs.existsSync(sock)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("kills the service pane", () => {
    expect(webPane).toBeDefined();
    expect(listAllPanes()).not.toContain(webPane);
  });

  it("frees the service port so a subsequent up has no conflict", async () => {
    expect(await portRefused(port)).toBe(true);
  });
});
