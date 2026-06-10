import { afterEach, describe, expect, it } from "vitest";

import { ServiceManager } from "#src/lib/service/manager.js";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps, waitForState } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("restartWith cascade integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort
    }
    await session.cleanup();
  });

  it("restart triggers restartWith dependents", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: {
        start: httpServerCmd(apiPort),
        ready: { port: apiPort },
        dependsOn: ["db"],
        restartWith: ["db"],
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();
    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");

    const apiReady = waitForState(mgr, "api", "ready");
    await mgr.restartService("db");
    await apiReady;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");
  });

  it("multi-level cascade: db→api→fe", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const fePort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api", "fe"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: {
        start: httpServerCmd(apiPort),
        ready: { port: apiPort },
        dependsOn: ["db"],
        restartWith: ["db"],
      },
      fe: {
        start: httpServerCmd(fePort),
        ready: { port: fePort },
        dependsOn: ["api"],
        restartWith: ["api"],
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();
    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");
    expect(mgr.getStatus("fe").state).toBe("ready");

    const apiReady = waitForState(mgr, "api", "ready");
    const feReady = waitForState(mgr, "fe", "ready");
    await mgr.restartService("db");
    await apiReady;
    await feReady;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");
    expect(mgr.getStatus("fe").state).toBe("ready");
  });

  it("restartWith does not restart stopped services", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: {
        start: httpServerCmd(apiPort),
        ready: { port: apiPort },
        dependsOn: ["db"],
        restartWith: ["db"],
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();
    await mgr.stopService("api");
    expect(mgr.getStatus("api").state).toBe("stopped");

    await mgr.restartService("db");

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("stopped");
  });
});
