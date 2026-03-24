import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("dependencies integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort stop
    }
    await session.cleanup();
  });

  it("db ready before api starts (dependsOn)", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: { start: httpServerCmd(apiPort), ready: { port: apiPort }, dependsOn: ["db"] },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    const readyOrder: string[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      if (status.state === "ready") {
        readyOrder.push(name);
      }
    });

    await mgr.startAll();

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");
    expect(readyOrder.indexOf("db")).toBeLessThan(readyOrder.indexOf("api"));
  });

  it("three-level chain: db -> api -> fe", async () => {
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

    const readyOrder: string[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      if (status.state === "ready") {
        readyOrder.push(name);
      }
    });

    await mgr.startAll();

    expect(readyOrder).toEqual(["db", "api", "fe"]);
  });

  it("diamond dependency: a→b, a→c, b→d, c→d", async () => {
    session = await createTestSession();
    const portA = await getFreePort();
    const portB = await getFreePort();
    const portC = await getFreePort();
    const portD = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["a", "b", "c", "d"]);

    const config = makeConfig({
      d: { start: httpServerCmd(portD), ready: { port: portD } },
      b: { start: httpServerCmd(portB), ready: { port: portB }, dependsOn: ["d"] },
      c: { start: httpServerCmd(portC), ready: { port: portC }, dependsOn: ["d"] },
      a: { start: httpServerCmd(portA), ready: { port: portA }, dependsOn: ["b", "c"] },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    const readyOrder: string[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      if (status.state === "ready") {
        readyOrder.push(name);
      }
    });

    await mgr.startAll();

    // D must be first, a must be last
    expect(readyOrder[0]).toBe("d");
    expect(readyOrder[readyOrder.length - 1]).toBe("a");
    // B and c should be between d and a
    expect(readyOrder.indexOf("b")).toBeGreaterThan(0);
    expect(readyOrder.indexOf("c")).toBeGreaterThan(0);
  });

  it("stopAll respects reverse order", async () => {
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

    // Fe depends on api depends on db → stop fe first, then api, then db
    expect(stopOrder.indexOf("fe")).toBeLessThan(stopOrder.indexOf("api"));
    expect(stopOrder.indexOf("api")).toBeLessThan(stopOrder.indexOf("db"));
  });

  it("dependency failure prevents dependent from starting", async () => {
    session = await createTestSession();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    // Db uses a ready function that always rejects — simulates fast startup failure
    const config = makeConfig({
      db: {
        start: 'node -e "process.exit(1)"',
        ready: async () => Promise.reject(new Error("db startup failed")),
      },
      api: { start: httpServerCmd(apiPort), ready: { port: apiPort }, dependsOn: ["db"] },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);

    // StartAll catches the error for db, then skips api (dep not ready)
    await mgr.startAll();

    // Db should be in error state (ready check rejected)
    expect(mgr.getStatus("db").state).toBe("error");

    // Api should NOT have started — dependency not ready
    expect(mgr.getStatus("api").state).toBe("stopped");
  });
});
