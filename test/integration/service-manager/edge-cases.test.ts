import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd, slowStartCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps, waitForState } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("edge-cases integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort stop
    }
    // Let background monitors (monitorCrash/monitorOutput) quiesce before killing session
    await new Promise((resolve) => setTimeout(resolve, 500));
    await session.cleanup();
  });

  it("double-start is no-op", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Second start should be a no-op
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("start with unready dependency throws", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: { start: httpServerCmd(apiPort), ready: { port: apiPort }, dependsOn: ["db"] },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    await expect(mgr.startService("api")).rejects.toThrow(/not ready/);
  });

  it("stopAll idempotent", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();

    await mgr.stopAll();
    // Second stopAll should not throw
    await mgr.stopAll();

    expect(mgr.getStatus("svc").state).toBe("stopped");
  });

  it("stopAll reverse order", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const fePort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api", "fe"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: { start: httpServerCmd(apiPort), ready: { port: apiPort }, dependsOn: ["db"] },
      fe: { start: httpServerCmd(fePort), ready: { port: fePort }, dependsOn: ["api"] },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    const stopOrder: string[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      if (status.state === "stopping") {
        stopOrder.push(name);
      }
    });

    await mgr.startAll();
    await mgr.stopAll();

    // Fe should stop before api, api before db
    expect(stopOrder.indexOf("fe")).toBeLessThan(stopOrder.indexOf("api"));
    expect(stopOrder.indexOf("api")).toBeLessThan(stopOrder.indexOf("db"));
  });

  it("stop during starting aborts cleanly", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: { start: slowStartCmd(port, 5000), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    // Start in background (will take 5s to become ready)
    const startPromise = mgr.startService("svc");

    // Wait for "starting" state
    await waitForState(mgr, "svc", "starting", 5000);

    // Stop immediately — should abort the ready poll
    await mgr.stopService("svc");
    expect(mgr.getStatus("svc").state).toBe("stopped");

    // Original start should resolve (aborted, no throw)
    await startPromise.catch(() => {
      // Expected — start aborted by stop
    });
  });

  it("rapid start/stop cycling leaves clean state", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    // Cycle 1
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");
    await mgr.stopService("svc");
    expect(mgr.getStatus("svc").state).toBe("stopped");

    // Cycle 2
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");
    await mgr.stopService("svc");
    expect(mgr.getStatus("svc").state).toBe("stopped");
  });
});
