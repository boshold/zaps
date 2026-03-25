/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ipcRequest } from "#src/lib/ipc/client.js";
import { capturePane, setEnv } from "#src/lib/tmux.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localZaps = path.join(projectRoot, "bin", "zaps");

function writeWrapperConfig(dir: string, port: number): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.defineProject({",
      '    name: "test-wrapper",',
      "    services: {",
      "      svc: {",
      `        start: ${JSON.stringify(cmd)},`,
      `        ready: { port: ${port} },`,
      '        env: { TEST_SECRET: "should-not-leak" },',
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("wrapper lifecycle", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string | undefined;

  beforeEach(async () => {
    // Daemon reads ZAPS_COMMAND to build the wrapper command sent to panes
    process.env["ZAPS_COMMAND"] = localZaps;
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-wrapper-"));

    // Wrapper in tmux pane reads ZAPS_SOCKET_PATH to find the test daemon
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
    delete process.env["ZAPS_COMMAND"];
  });

  it("starts service via wrapper and hides env vars from pane", async () => {
    const port = await getFreePort();
    const configPath = writeWrapperConfig(tmpDir, port);

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

    // Pane shows wrapper command, not inline env
    expect(output).toContain("exec-service");
    expect(output).not.toContain("TEST_SECRET=");
    expect(output).not.toContain("should-not-leak");
  });

  it("service output appears normally through wrapper", async () => {
    const port = await getFreePort();
    const configPath = writeWrapperConfig(tmpDir, port);

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

    // Child's stdout should be visible in the pane
    expect(output).toContain(`ready on port ${port}`);
  });

  it("stop service via daemon — wrapper exits cleanly", async () => {
    const port = await getFreePort();
    const configPath = writeWrapperConfig(tmpDir, port);

    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "svc", "ready");

    await ipcRequest(daemon.socketPath, "services.stop", { name: "svc" }, 10_000, sid);
    await waitForServiceState(daemon.socketPath, sid, "svc", "stopped");

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    const statuses = listRes.result as { name: string; state: string }[];
    const svc = statuses.find((s) => s.name === "svc");
    expect(svc?.state).toBe("stopped");
  });

  it("restart service via wrapper — stop + start cycle", async () => {
    const port = await getFreePort();
    const configPath = writeWrapperConfig(tmpDir, port);

    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "svc", "ready");

    await ipcRequest(daemon.socketPath, "services.restart", { name: "svc" }, 15_000, sid);
    await waitForServiceState(daemon.socketPath, sid, "svc", "ready", 20_000);

    const paneId = (res.result as { paneMap: Record<string, string> }).paneMap.svc;
    const output = await capturePane(paneId, 50);

    expect(output).toContain("exec-service");
    expect(output).not.toContain("TEST_SECRET=");
  });
});
