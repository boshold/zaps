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
import { createTestSession } from "../helpers/tmux.js";

function writeConfig(
  dir: string,
  name: string,
  services: Record<string, { port: number }>,
): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const svcEntries = Object.entries(services).map(([svcName, { port }]) => {
    const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
    return `      ${svcName}: { start: ${JSON.stringify(cmd)}, ready: { port: ${port} }, raw: true }`;
  });
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.defineProject({",
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

  it("reload restarts services from updated config", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Reload the same config — services should restart
    const reloadRes = await ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid);
    expect(reloadRes.error).toBeUndefined();

    // Services restart in background after reload — wait for them
    await waitForServiceState(daemon.socketPath, sid, "web", "ready", 30_000);

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(listRes.error).toBeUndefined();
    const statuses = listRes.result as { name: string; state: string }[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0].name).toBe("web");
    expect(statuses[0].state).toBe("ready");
  });

  it("reload emits configReloaded event", async () => {
    const port1 = await getFreePort();
    const configPath = writeConfig(tmpDir, "test-reload", { web: { port: port1 } });

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
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
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Fire 2 reloads in parallel
    const [res1, res2] = await Promise.all([
      ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid),
      ipcRequest(daemon.socketPath, "session.reload", undefined, 30_000, sid),
    ]);

    expect(res1.error).toBeUndefined();
    expect(res2.error).toBeUndefined();

    await waitForServiceState(daemon.socketPath, sid, "web", "ready", 30_000);

    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(listRes.error).toBeUndefined();
    const statuses = listRes.result as { name: string; state: string }[];
    expect(statuses.length).toBeGreaterThan(0);
  });
});
