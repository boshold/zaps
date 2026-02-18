import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import {
  capturePane,
  getWindowName,
  panePid,
  renameWindow,
  sendCtrlC,
  sendKeys,
} from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { outputOnlyCmd } from "../helpers/fixtures.js";
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
};

describe.skipIf(!hasTmux())("ready-output integration", () => {
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

  it("ready: { output: /regex/ } matches pane output", async () => {
    session = await createTestSession();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: outputOnlyCmd("service-is-ready", 1000),
        ready: { output: /service-is-ready/ },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("ready: { output: fn } predicate function", async () => {
    session = await createTestSession();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: outputOnlyCmd("listening-now", 500),
        ready: { output: (line: string) => line.includes("listening-now") },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
  });
});
