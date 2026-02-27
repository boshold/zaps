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
import { httpHealthServerCmd } from "../helpers/fixtures.js";
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

describe.skipIf(!hasTmux())("ready-http integration", () => {
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

  it('ready: { http: "/health" }', async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: httpHealthServerCmd(port, "/health"),
        ready: { http: "/health" },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it('ready: { http: { url: "/status", status: 200 } }', async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: httpHealthServerCmd(port, "/status"),
        ready: { http: { url: "/status", status: 200 } },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
  });
});
