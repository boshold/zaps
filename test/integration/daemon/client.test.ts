/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DaemonClient } from "#src/client/daemon-client.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import type { TestDaemon } from "../helpers/daemon.js";
import {
  createTestDaemon,
  waitForAllServices,
  waitForServiceState,
  writeMultiServiceConfig,
} from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("DaemonClient integration", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string;
  let client: DaemonClient;
  let port1: number;
  let port2: number;

  beforeAll(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    port1 = await getFreePort();
    port2 = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-client-"));
    writeMultiServiceConfig(tmpDir, port1, port2);

    const configPath = path.join(tmpDir, ".zaps.mjs");
    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    sid = (res.result as { id: string }).id;

    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "ready");

    client = new DaemonClient(daemon.socketPath, sid);
  });

  afterAll(async () => {
    try {
      client.disconnect();
    } catch {
      /* Best-effort */
    }
    try {
      await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
    } catch {
      /* Best-effort cleanup */
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Connection ─────────────────────────────────────────────────────

  it("connect() sets connected to true", async () => {
    client.connect();
    // Allow subscription to establish
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.connected).toBe(true);
  });

  it("session getter returns session id", () => {
    expect(client.session).toBe(sid);
  });

  // ── Session operations ─────────────────────────────────────────────

  it("attach() returns valid SessionSnapshot", async () => {
    const snap = await client.attach();
    expect(snap.id).toBe(sid);
    expect(snap.name).toBe("test-multi");
    expect(snap.paneMap).toBeDefined();
    expect(snap.statuses.length).toBeGreaterThan(0);
    expect(snap.servicesMeta.length).toBeGreaterThan(0);
  });

  // ── Service operations ─────────────────────────────────────────────

  it("listServices() returns service statuses", async () => {
    const statuses = await client.listServices();
    expect(statuses).toHaveLength(2);
    const names = statuses.map((s) => s.name).toSorted();
    expect(names).toEqual(["api", "web"]);
  });

  it("stopService() transitions service to stopped", async () => {
    await client.stopService("api");
    await waitForServiceState(daemon.socketPath, sid, "api", "stopped");

    const statuses = await client.listServices();
    const api = statuses.find((s) => s.name === "api");
    expect(api?.state).toBe("stopped");
  });

  it("startService() transitions service to ready", async () => {
    await client.startService("api");
    await waitForServiceState(daemon.socketPath, sid, "api", "ready");

    const statuses = await client.listServices();
    const api = statuses.find((s) => s.name === "api");
    expect(api?.state).toBe("ready");
  });

  it("restartService() cycles service back to ready", async () => {
    await client.restartService("web");
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    const statuses = await client.listServices();
    const web = statuses.find((s) => s.name === "web");
    expect(web?.state).toBe("ready");
  });

  it("restartAll() cycles all services", async () => {
    await client.restartAll();
    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "ready");

    const statuses = await client.listServices();
    for (const s of statuses) {
      expect(s.state).toBe("ready");
    }
  });

  // ── Logs ───────────────────────────────────────────────────────────

  it("getLogSnapshot() returns lines for a service", async () => {
    // Let LogMonitor capture at least one cycle
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const lines = await client.getLogSnapshot("api");
    expect(lines.length).toBeGreaterThan(0);
  });

  // ── Events ─────────────────────────────────────────────────────────

  it("emits service.stateChange on stop/start", async () => {
    const events: { name: string; status: ServiceStatus }[] = [];
    client.on("service.stateChange", (name: string, status: ServiceStatus) => {
      events.push({ name, status });
    });

    await client.stopService("api");
    await waitForServiceState(daemon.socketPath, sid, "api", "stopped");
    // Allow events to propagate
    await new Promise((resolve) => setTimeout(resolve, 500));

    const apiEvents = events.filter((e) => e.name === "api");
    expect(apiEvents.length).toBeGreaterThan(0);

    client.removeAllListeners("service.stateChange");

    // Restart for subsequent tests
    await client.startService("api");
    await waitForServiceState(daemon.socketPath, sid, "api", "ready");
  });

  it("emits log.lines events", async () => {
    const logEvents: { service: string; lines: string[] }[] = [];
    client.on("log.lines", (service: string, lines: string[]) => {
      logEvents.push({ service, lines });
    });

    // Restart a service to generate fresh log output
    await client.restartService("web");
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Allow LogMonitor to capture new output
    await new Promise((resolve) => setTimeout(resolve, 1500));

    client.removeAllListeners("log.lines");

    expect(logEvents.length).toBeGreaterThan(0);
  });

  // ── Disconnect ─────────────────────────────────────────────────────

  it("disconnect() sets connected to false", () => {
    client.disconnect();
    expect(client.connected).toBe(false);
  });
});
