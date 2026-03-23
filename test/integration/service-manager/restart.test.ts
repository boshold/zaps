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
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { crashingCmd, httpServerCmd } from "../helpers/fixtures.js";
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
  exec: async () => {
    /* No-op */
  },
};

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
    function listener(n: string, status: ServiceStatus) {
      if (n === name && status.state === target) {
        clearTimeout(timer); // eslint-disable-line no-use-before-define -- circular timer/listener
        mgr.removeListener("stateChange", listener);
        resolve();
      }
    }

    const timer = setTimeout(() => {
      mgr.removeListener("stateChange", listener);
      reject(new Error(`Timed out waiting for ${name} to reach ${target}`));
    }, timeoutMs);
    mgr.on("stateChange", listener);
  });
}

describe.skipIf(!hasTmux())("restart integration", () => {
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

  it("restart running service", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("web");
    expect(mgr.getStatus("web").state).toBe("ready");

    await mgr.restartService("web");
    expect(mgr.getStatus("web").state).toBe("ready");
    expect(mgr.getStatus("web").ports).toContain(port);
  });

  it("restart resets retryCount", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: crashingCmd(port, 3000),
        ready: { port },
        restart: { maxRetries: 3, backoff: 500 },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Wait for crash + auto-restart
    await waitForState(mgr, "svc", "restarting");
    await waitForState(mgr, "svc", "ready");
    expect(mgr.getStatus("svc").retryCount).toBe(1);

    // Manual restart should reset retryCount
    await mgr.restartService("svc");
    expect(mgr.getStatus("svc").retryCount).toBe(0);
    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("restart stopped service", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["web"]);

    const config = makeConfig({
      web: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("web");
    await mgr.stopService("web");
    expect(mgr.getStatus("web").state).toBe("stopped");

    await mgr.restartService("web");
    expect(mgr.getStatus("web").state).toBe("ready");
  });
});
