import { afterEach, describe, expect, it } from "vitest";

import { ServiceManager } from "#src/lib/service/manager.js";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("flags integration", () => {
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

  it("flags.start=false excluded from startAll", async () => {
    session = await createTestSession();
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const port3 = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc1", "svc2", "svc3"]);

    const config = makeConfig({
      svc1: { start: httpServerCmd(port1), ready: { port: port1 } },
      svc2: { start: httpServerCmd(port2), ready: { port: port2 }, flags: { start: false } },
      svc3: { start: httpServerCmd(port3), ready: { port: port3 } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();

    expect(mgr.getStatus("svc1").state).toBe("ready");
    expect(mgr.getStatus("svc2").state).toBe("stopped");
    expect(mgr.getStatus("svc3").state).toBe("ready");
  });

  it("excluded service can be started manually", async () => {
    session = await createTestSession();
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc1", "svc2"]);

    const config = makeConfig({
      svc1: { start: httpServerCmd(port1), ready: { port: port1 } },
      svc2: { start: httpServerCmd(port2), ready: { port: port2 }, flags: { start: false } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();

    expect(mgr.getStatus("svc2").state).toBe("stopped");

    await mgr.startService("svc2");
    expect(mgr.getStatus("svc2").state).toBe("ready");
  });
});
