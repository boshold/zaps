import { afterEach, describe, expect, it } from "vitest";

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
  tmuxFor,
} from "#src/lib/tmux.js";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession, testTmuxSocket } from "../helpers/tmux.js";
import { waitFor } from "../helpers/wait.js";

const deps = {
  sendKeys,
  sendCtrlC,
  panePid,
  detectPorts: async (paneTarget: string) => detectPorts(paneTarget, tmuxFor(testTmuxSocket())),
  capturePane,
  getDescendantPids,
  renameWindow,
  getWindowName,
  getWindowOption,
  setWindowOption,
  exec: async () => {
    /* No-op */
  },
  preflightPorts: async () => null,
  storeExecInfo: () => {
    /* No-op */
  },
  sessionId: "test-session-id",
  zapsCommand: "zaps",
  reflowInsert: async () => {
    /* No-op for tests that don't exercise lazy lifecycle */
  },
  reflowRemove: async () => {
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

    // Poll for the async window rename to settle (both services ready).
    const title = await waitFor(
      async () => getWindowName(paneMap["@tui"]),
      (t) => t.includes("zaps") && t.includes("●2"),
    );
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

    // Title should have changed — poll until the rename lands.
    const runningTitle = await waitFor(
      async () => getWindowName(paneMap["@tui"]),
      (t) => t.includes("zaps"),
    );
    expect(runningTitle).toContain("zaps");

    await mgr.stopAll();

    const restoredTitle = await waitFor(
      async () => getWindowName(paneMap["@tui"]),
      (t) => t === "my-custom-title",
    );
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

    const autoRename = await waitFor(
      async () => getWindowOption(paneMap["@tui"], "automatic-rename"),
      (v) => v === "on",
    );
    expect(autoRename).toBe("on");
  });
});
