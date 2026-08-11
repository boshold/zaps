/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

function writeConfig(
  dir: string,
  name: string,
  services: Record<string, { port: number }>,
): string {
  const configPath = path.join(dir, ".zaps.mts");
  const svcEntries = Object.entries(services).map(([svcName, { port }]) => {
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
    return `      ${svcName}: { start: ${JSON.stringify(cmd)}, ready: { port: ${port} }, raw: true }`;
  });
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.define({",
      `    name: ${JSON.stringify(name)},`,
      "    services: {",
      ...svcEntries.map((e) => `${e},`),
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("config hot-reload", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string;

  beforeEach(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-reload-"));
  });

  afterEach(async () => {
    try {
      await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
    } catch {
      /* Best-effort cleanup */
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reload picks up an edited config (fresh module graph) and restarts services", async () => {
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Edit the config: add a second service. The fresh load must reflect it.
    writeConfig(tmpDir, "test-reload", { web: { port: port1 }, api: { port: port2 } });

    const reloadRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid);
    expect(reloadRes.error).toBeUndefined();

    await waitForServiceState(daemon.socketPath, sid, "web", "ready", 30_000);
    await waitForServiceState(daemon.socketPath, sid, "api", "ready", 30_000);

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(listRes.error).toBeUndefined();
    const statuses = listRes.result as { name: string; state: string }[];
    const names = statuses.map((s) => s.name).toSorted();
    expect(names).toEqual(["api", "web"]);
    expect(statuses.every((s) => s.state === "ready")).toBe(true);
  });

  it("reload emits configReloaded event", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    const allEvents: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["session.configReloaded"], (event) => {
      allEvents.push(event);
    });

    // Confirm subscription is live
    await ipcRequest(daemon.socketPath, "daemon.ping");

    const reloadRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid);
    expect(reloadRes.error).toBeUndefined();

    // Wait for configReloaded event (subscription receives all events, filter client-side)
    const deadline = Date.now() + 10_000;
    let reloadEvent: DaemonEvent | undefined;
    while (!reloadEvent && Date.now() < deadline) {
      reloadEvent = allEvents.find((e) => e.event === "session.configReloaded");
      if (!reloadEvent) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    sub.close();

    expect(reloadEvent).toBeDefined();
    const data = reloadEvent!.data as { id: string; name: string; statuses: unknown[] };
    expect(data.id).toBe(sid);
    expect(data.name).toBe("test-reload");
    expect(Array.isArray(data.statuses)).toBe(true);
  });

  it("concurrent reload is guarded", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Fire 2 reloads in parallel
    const [res1, res2] = await Promise.all([
      ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid),
      ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid),
    ]);

    // At least one succeeds; any failure is only the concurrent-reload guard.
    const errors = [res1.error, res2.error].filter(Boolean) as string[];
    expect(errors.length).toBeLessThanOrEqual(1);
    for (const err of errors) {
      expect(err).toContain("reload already in progress");
    }

    await waitForServiceState(daemon.socketPath, sid, "web", "ready", 30_000);

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(listRes.error).toBeUndefined();
    const statuses = listRes.result as { name: string; state: string }[];
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("invalid config leaves the running session intact (A1)", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Break the config: unterminated define call.
    fs.writeFileSync(configPath, "export function config(lib) { return lib.define({ \n");

    const reloadRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid);
    expect(reloadRes.error).toBeDefined();

    // The previously-running service must still be ready (untouched).
    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(listRes.error).toBeUndefined();
    const statuses = listRes.result as { name: string; state: string }[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0].name).toBe("web");
    expect(statuses[0].state).toBe("ready");
  });

  it("reload with a first-leaf service keeps the TUI pane as @tui (A2)", async () => {
    const port1 = await getFreePort();
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port1},()=>console.log('ready on port ${port1}'))"`;
    const configPath = path.join(tmpDir, ".zaps.mts");
    // Layout's FIRST leaf is a service, @tui second — the A2 trigger.
    const configText = [
      "export function config(lib) {",
      "  return lib.define({",
      '    name: "layout-reload",',
      "    services: {",
      `      web: { start: ${JSON.stringify(cmd)}, ready: { port: ${port1} }, raw: true },`,
      "    },",
      '    layout: { direction: "rows", children: [{ pane: "web" }, { pane: "@tui" }] },',
      "  });",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, configText);

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    const tuiPaneBefore = (createRes.result as { paneMap: Record<string, string> }).paneMap["@tui"];
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Touch the config so the reload reloads the same first-leaf-service layout.
    fs.writeFileSync(configPath, configText);
    const reloadRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid);
    expect(reloadRes.error).toBeUndefined();
    await waitForServiceState(daemon.socketPath, sid, "web", "ready", 30_000);

    const attachRes = await ipcRequest(daemon.socketPath, "session.attach", undefined, 5000, sid);
    const { paneMap } = attachRes.result as { paneMap: Record<string, string> };

    // @tui stays on the pane the TUI runs in; the service never clobbers it.
    expect(paneMap["@tui"]).toBe(tuiPaneBefore);
    expect(paneMap.web).not.toBe(tuiPaneBefore);
  });

  it("reload racing destroy neither orphans panes nor double-tears-down", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Destroy while a reload is in flight — must settle cleanly either way.
    const [reloadRes, destroyRes] = await Promise.all([
      ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid),
      ipcRequest(daemon.socketPath, "session.destroy", undefined, 30_000, sid),
    ]);
    expect(destroyRes.error).toBeUndefined();

    // Reload either won the race (ok) or lost it (session destroyed / unknown).
    if (reloadRes.error !== undefined) {
      expect(reloadRes.error).toMatch(/session destroyed|Unknown session/u);
    }

    // The session is gone; a follow-up reload no longer resolves a live session.
    const afterRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 10_000, sid);
    expect(afterRes.error).toBeDefined();
  });
});
