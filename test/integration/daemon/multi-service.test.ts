/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("multi-service operations", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string;
  let port1: number;
  let port2: number;

  beforeAll(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    port1 = await getFreePort();
    port2 = await getFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-"));
    writeMultiServiceConfig(tmpDir, port1, port2);

    const configPath = path.join(tmpDir, ".zaps.mjs");
    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;

    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "ready");
  });

  afterAll(async () => {
    try {
      await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
    } catch {
      /* Best-effort cleanup */
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Bulk operations ────────────────────────────────────────────────

  it("services.list returns both services as ready", async () => {
    const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    expect(res.error).toBeUndefined();
    const statuses = res.result as { name: string; state: string }[];
    expect(statuses).toHaveLength(2);
    const names = statuses.map((s) => s.name).toSorted();
    expect(names).toEqual(["api", "web"]);
    for (const s of statuses) {
      expect(s.state).toBe("ready");
    }
  });

  it("services.stopAll stops both services", async () => {
    const res = await ipcRequest(daemon.socketPath, "services.stopAll", undefined, 15_000, sid);
    expect(res.error).toBeUndefined();
    expect((res.result as { stopped: string }).stopped).toBe("all");

    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "stopped");
  });

  it("services.startAll starts both services back", async () => {
    const res = await ipcRequest(daemon.socketPath, "services.startAll", undefined, 15_000, sid);
    expect(res.error).toBeUndefined();
    expect((res.result as { started: string }).started).toBe("all");

    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "ready");
  });

  // ── Named subset operations ────────────────────────────────────────

  it("services.stopAll with names stops only named service", async () => {
    const res = await ipcRequest(
      daemon.socketPath,
      "services.stopAll",
      { names: ["api"] },
      15_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { stopped: string[] }).stopped).toEqual(["api"]);

    await waitForServiceState(daemon.socketPath, sid, "api", "stopped");

    // Web should still be ready
    const list = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    const statuses = list.result as { name: string; state: string }[];
    const web = statuses.find((s) => s.name === "web");
    expect(web?.state).toBe("ready");
  });

  it("services.startAll with names starts only named service", async () => {
    // Api was stopped by previous test
    const res = await ipcRequest(
      daemon.socketPath,
      "services.startAll",
      { names: ["api"] },
      15_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { started: string[] }).started).toEqual(["api"]);

    await waitForServiceState(daemon.socketPath, sid, "api", "ready");
  });

  it("services.restartAll cycles both services", async () => {
    const res = await ipcRequest(daemon.socketPath, "services.restartAll", undefined, 20_000, sid);
    expect(res.error).toBeUndefined();
    expect((res.result as { restarted: string }).restarted).toBe("all");

    await waitForAllServices(daemon.socketPath, sid, ["api", "web"], "ready");
  });

  it("services.restartAll with names restarts only named service", async () => {
    const res = await ipcRequest(
      daemon.socketPath,
      "services.restartAll",
      { names: ["web"] },
      15_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { restarted: string[] }).restarted).toEqual(["web"]);

    await waitForServiceState(daemon.socketPath, sid, "web", "ready");
  });

  // ── Tasks ──────────────────────────────────────────────────────────

  it("tasks.list returns configured tasks", async () => {
    const res = await ipcRequest(daemon.socketPath, "tasks.list", undefined, 5000, sid);
    expect(res.error).toBeUndefined();
    const tasks = res.result as { key: string; name: string; description: string | null }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("build");
    expect(tasks[0].name).toBe("Build");
  });

  it("tasks.run streams line events and returns success", async () => {
    const lines: string[] = [];
    const res = await ipcStream(
      daemon.socketPath,
      "tasks.run",
      { key: "build" },
      (event, data) => {
        if (event === "line") {
          lines.push(data as string);
        }
      },
      30_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { success: boolean }).success).toBe(true);
    expect(lines.some((l) => l.includes("build-ok"))).toBe(true);
  });

  it("tasks.run with unknown task returns error", async () => {
    const res = await ipcStream(
      daemon.socketPath,
      "tasks.run",
      { key: "nonexistent" },
      () => {
        /* No-op */
      },
      5000,
      sid,
    );
    expect(res.error).toContain("Unknown task");
  });

  // ── Log event subscription ─────────────────────────────────────────

  it("subscribe receives log.lines events for a service", async () => {
    const logEvents: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["log.lines"], (event) =>
      logEvents.push(event),
    );

    // Wait for subscription to establish
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Restart a service to generate fresh log output
    await ipcRequest(daemon.socketPath, "services.restart", { name: "api" }, 15_000, sid);
    await waitForServiceState(daemon.socketPath, sid, "api", "ready");

    // Allow LogMonitor to capture new output
    await new Promise((resolve) => setTimeout(resolve, 1500));
    sub.close();

    const serviceLogs = logEvents.filter((e) => {
      const data = e.data as { service: string };
      return data.service === "api" || data.service === "web";
    });
    expect(serviceLogs.length).toBeGreaterThan(0);
  });
});
