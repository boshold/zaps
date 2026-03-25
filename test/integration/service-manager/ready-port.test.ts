import { ServiceManager } from "#src/lib/service/manager.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { slowStartCmd, wrapperStartCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("ready-port integration", () => {
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

  it("ready: { port: N } with slow-start server", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: slowStartCmd(port, 2000), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("web");

    expect(mgr.getStatus("web").state).toBe("ready");
    expect(mgr.getStatus("web").ports).toContain(port);
  });

  it("ready: { port: true } detects any port", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: slowStartCmd(port, 1000), ready: { port: true } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("web");

    expect(mgr.getStatus("web").state).toBe("ready");
    expect(mgr.getStatus("web").ports).toContain(port);
  });

  it("ready: { port: true } detects port from wrapper child process", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: wrapperStartCmd(port, 1000), ready: { port: true } },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("web");

    expect(mgr.getStatus("web").state).toBe("ready");
    expect(mgr.getStatus("web").ports).toContain(port);
  });
});
