import { ServiceManager } from "#src/lib/service/manager.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { crashingCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps, waitForState } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("crash-recovery integration", () => {
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

  it("auto-restarts crashed service and increments retryCount", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: crashingCmd(port, 3000),
        ready: { port },
        restart: { maxRetries: 2, backoff: 500 },
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Wait for crash detection + auto-restart → ready again (slow under parallel load)
    await waitForState(mgr, "svc", "restarting", 15_000);
    await waitForState(mgr, "svc", "ready", 15_000);

    expect(mgr.getStatus("svc").retryCount).toBe(1);
  });

  it("crash with no restart config → immediate error", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: crashingCmd(port, 2000),
        ready: { port },
        // No restart config
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Should go to error directly (no restart)
    await waitForState(mgr, "svc", "error", 30_000);
    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").retryCount).toBe(0);
  });

  it("transitions to error when retries exhausted", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    // Crash after 2s, only 1 retry allowed, and the retry will also crash
    const config = makeConfig({
      svc: {
        start: crashingCmd(port, 2000),
        ready: { port },
        restart: { maxRetries: 1, backoff: 500 },
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // First crash → restart (slow under parallel load)
    await waitForState(mgr, "svc", "restarting", 15_000);
    await waitForState(mgr, "svc", "ready", 15_000);
    expect(mgr.getStatus("svc").retryCount).toBe(1);

    // Second crash → error (retries exhausted, generous timeout for parallel load)
    await waitForState(mgr, "svc", "error", 30_000);
    expect(mgr.getStatus("svc").state).toBe("error");
  });
});
