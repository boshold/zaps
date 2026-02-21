import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import {
  capturePane,
  getWindowName,
  getWindowOption,
  panePid,
  renameWindow,
  sendCtrlC,
  sendKeys,
  setWindowOption,
} from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

const deps = {
  sendKeys,
  sendCtrlC,
  panePid,
  detectPorts,
  capturePane,
  getDescendantPids,
  renameWindow,
  getWindowName,
  getWindowOption,
  setWindowOption,
};

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

    mgr = new ServiceManager(config, paneMap, deps, session.name);

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

    mgr = new ServiceManager(config, paneMap, deps, session.name);

    const readyOrder: string[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      if (status.state === "ready") {
        readyOrder.push(name);
      }
    });

    await mgr.startAll();

    expect(readyOrder).toEqual(["db", "api", "fe"]);
  });
});
