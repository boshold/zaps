/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest } from "#src/lib/ipc/client.js";
import { capturePane, setEnv } from "#src/lib/tmux.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localZaps = path.join(projectRoot, "bin", "zaps");

describe.skipIf(!hasTmux())("raw mode and crash detection", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string | undefined;

  beforeEach(async () => {
    process.env.ZAPS_COMMAND = localZaps;
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-raw-crash-"));
    await setEnv(tmux.name, "ZAPS_SOCKET_PATH", daemon.socketPath);
  });

  afterEach(async () => {
    if (sid) {
      try {
        await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
      } catch {
        /* Best-effort cleanup */
      }
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ZAPS_COMMAND;
  });

  it("raw: true service shows inline env in pane", async () => {
    const port = await getFreePort();
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
    const configPath = path.join(tmpDir, ".zaps.mjs");
    fs.writeFileSync(
      configPath,
      [
        "export function config(lib) {",
        "  return lib.defineProject({",
        '    name: "test-raw",',
        "    services: {",
        "      svc: {",
        `        start: ${JSON.stringify(cmd)},`,
        `        ready: { port: ${port} },`,
        '        env: { RAW_VAR: "visible" },',
        "        raw: true,",
        "      },",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "svc", "ready");

    const paneId = (res.result as { paneMap: Record<string, string> }).paneMap.svc;
    const output = await capturePane(paneId, 50);

    // Raw mode: inline env IS visible in the pane
    expect(output).toContain("RAW_VAR=");
    // Should NOT show exec-service wrapper
    expect(output).not.toContain("exec-service");
  });

  it("wrapper-mode crash detected within 2s via exit notification", async () => {
    const port = await getFreePort();
    // Service starts, reaches ready, then crashes after 2s
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>{console.log('ready on port ${port}');setTimeout(()=>process.exit(1),2000)})"`;
    const configPath = path.join(tmpDir, ".zaps.mjs");
    fs.writeFileSync(
      configPath,
      [
        "export function config(lib) {",
        "  return lib.defineProject({",
        '    name: "test-crash",',
        "    services: {",
        "      svc: {",
        `        start: ${JSON.stringify(cmd)},`,
        `        ready: { port: ${port} },`,
        "        restart: { maxRetries: 1, backoff: 500 },",
        "      },",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "svc", "ready");
    const readyAt = Date.now();

    // Wait for crash → restarting transition (wrapper reports exit via IPC)
    await waitForServiceState(daemon.socketPath, sid, "svc", "restarting", 10_000);
    const restartingAt = Date.now();

    // Crash happens ~2s after ready. Exit notification should arrive within ~1s of crash.
    // Total time from ready to restarting should be < 5s (2s crash delay + margin).
    // If using 10s polling, it would take 2s + up to 10s = 12s.
    const elapsed = restartingAt - readyAt;
    expect(elapsed).toBeLessThan(5000);

    // Wait for restart to complete so afterEach doesn't race with in-flight sendKeys
    await waitForServiceState(daemon.socketPath, sid, "svc", "ready", 15_000);
  });

  it("crash without restart config transitions to error", async () => {
    const port = await getFreePort();
    // Service starts, reaches ready, then crashes after 1s — no restart config
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>{console.log('ready on port ${port}');setTimeout(()=>process.exit(1),1000)})"`;
    const configPath = path.join(tmpDir, ".zaps.mjs");
    fs.writeFileSync(
      configPath,
      [
        "export function config(lib) {",
        "  return lib.defineProject({",
        '    name: "test-crash-no-restart",',
        "    services: {",
        "      svc: {",
        `        start: ${JSON.stringify(cmd)},`,
        `        ready: { port: ${port} },`,
        "      },",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "svc", "ready");

    // No restart config — should go directly to error
    await waitForServiceState(daemon.socketPath, sid, "svc", "error", 10_000);

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    const statuses = listRes.result as { name: string; state: string }[];
    const svc = statuses.find((s) => s.name === "svc");
    expect(svc?.state).toBe("error");
  });
});
