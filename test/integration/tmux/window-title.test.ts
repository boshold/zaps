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
  exec: async () => {
    /* No-op */
  },
};

describe.skipIf(!hasTmux())("window-title integration", () => {
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

  it("window title updates on startAll", async () => {
    session = await createTestSession();
    const port1 = await getFreePort();
    const port2 = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc1", "svc2"]);

    const config = makeConfig({
      svc1: { start: httpServerCmd(port1), ready: { port: port1 } },
      svc2: { start: httpServerCmd(port2), ready: { port: port2 } },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();

    // Wait for async window rename to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    const title = await getWindowName(paneMap["@tui"]);
    expect(title).toContain("zaps");
    expect(title).toContain("●2");
  });

  it("window title restored on stopAll", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    // Set a static title so automatic-rename doesn't interfere
    await setWindowOption(paneMap["@tui"], "automatic-rename", "off");
    await renameWindow(paneMap["@tui"], "my-custom-title");

    const config = makeConfig({
      svc: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();

    // Title should have changed
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runningTitle = await getWindowName(paneMap["@tui"]);
    expect(runningTitle).toContain("zaps");

    await mgr.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const restoredTitle = await getWindowName(paneMap["@tui"]);
    expect(restoredTitle).toBe("my-custom-title");
  });

  it("automatic-rename restoration", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    // Enable automatic-rename
    await setWindowOption(paneMap["@tui"], "automatic-rename", "on");

    const config = makeConfig({
      svc: { start: httpServerCmd(port), ready: { port } },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();
    await mgr.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const autoRename = await getWindowOption(paneMap["@tui"], "automatic-rename");
    expect(autoRename).toBe("on");
  });
});
