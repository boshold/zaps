import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import { capturePane, panePid, sendCtrlC, sendKeys } from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

const deps = { sendKeys, sendCtrlC, panePid, detectPorts, capturePane, getDescendantPids };

describe.skipIf(!hasTmux())("start-stop integration", () => {
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

  it("starts a single HTTP server and reaches ready", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps);
    await mgr.startService("web");

    expect(mgr.getStatus("web").state).toBe("ready");
    expect(mgr.getStatus("web").ports).toContain(port);
  });

  it("stops a running server", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps);
    await mgr.startService("web");
    expect(mgr.getStatus("web").state).toBe("ready");

    await mgr.stopService("web");
    expect(mgr.getStatus("web").state).toBe("stopped");
  });

  it("startAll + stopAll with 2 independent services", async () => {
    session = await createTestSession();
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc1", "svc2"]);

    const config = makeConfig({
      svc1: { start: httpServerCmd(port1), ready: { port: port1 } },
      svc2: { start: httpServerCmd(port2), ready: { port: port2 } },
    });

    mgr = new ServiceManager(config, paneMap, deps);
    await mgr.startAll();

    expect(mgr.getStatus("svc1").state).toBe("ready");
    expect(mgr.getStatus("svc2").state).toBe("ready");

    await mgr.stopAll();

    expect(mgr.getStatus("svc1").state).toBe("stopped");
    expect(mgr.getStatus("svc2").state).toBe("stopped");
  });
});
