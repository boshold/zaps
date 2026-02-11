import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { capturePane, panePid, sendCtrlC, sendKeys } from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { crashingCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

const deps = { sendKeys, sendCtrlC, panePid, detectPorts, capturePane, getDescendantPids };

async function waitForState(
  mgr: ServiceManager,
  name: string,
  target: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (mgr.getStatus(name).state === target) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      mgr.removeListener("stateChange", listener);
      reject(new Error(`Timed out waiting for ${name} to reach ${target}`));
    }, timeoutMs);

    function listener(n: string, status: ServiceStatus) {
      if (n === name && status.state === target) {
        clearTimeout(timer);
        mgr.removeListener("stateChange", listener);
        resolve();
      }
    }
    mgr.on("stateChange", listener);
  });
}

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

    mgr = new ServiceManager(config, paneMap, deps);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Wait for crash detection + auto-restart → ready again
    await waitForState(mgr, "svc", "restarting");
    await waitForState(mgr, "svc", "ready");

    expect(mgr.getStatus("svc").retryCount).toBe(1);
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

    mgr = new ServiceManager(config, paneMap, deps);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // First crash → restart
    await waitForState(mgr, "svc", "restarting");
    await waitForState(mgr, "svc", "ready");
    expect(mgr.getStatus("svc").retryCount).toBe(1);

    // Second crash → error (retries exhausted)
    await waitForState(mgr, "svc", "error", 30_000);
    expect(mgr.getStatus("svc").state).toBe("error");
  });
});
