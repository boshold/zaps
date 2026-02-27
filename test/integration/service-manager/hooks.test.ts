import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
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
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
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

describe.skipIf(!hasTmux())("hooks integration", () => {
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

  it("project-level hooks fire in order", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const order: string[] = [];

    const config = makeConfig(
      { svc: { start: httpServerCmd(port), ready: { port } } },
      {
        hooks: {
          onBeforeStart: () => {
            order.push("onBeforeStart");
          },
          onStart: () => {
            order.push("onStart");
          },
          onStop: () => {
            order.push("onStop");
          },
        },
      },
    );

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();
    expect(order).toEqual(["onBeforeStart", "onStart"]);

    await mgr.stopAll();
    expect(order).toEqual(["onBeforeStart", "onStart", "onStop"]);
  });

  it("service-level onBeforeStart + onReady + onStop", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const order: string[] = [];

    const config = makeConfig({
      svc: {
        start: httpServerCmd(port),
        ready: { port },
        onBeforeStart: () => {
          order.push("svc:onBeforeStart");
        },
        onReady: () => {
          order.push("svc:onReady");
        },
        onStop: () => {
          order.push("svc:onStop");
        },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");
    expect(order).toContain("svc:onBeforeStart");
    expect(order).toContain("svc:onReady");
    expect(order.indexOf("svc:onBeforeStart")).toBeLessThan(order.indexOf("svc:onReady"));

    await mgr.stopService("svc");
    expect(order).toContain("svc:onStop");
  });

  it("onBeforeStart hook error doesn't block start", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: httpServerCmd(port),
        ready: { port },
        onBeforeStart: () => {
          throw new Error("hook-failed");
        },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").lastError).toContain("hook-failed");
  });
});
