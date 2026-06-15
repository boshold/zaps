/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { killPane } from "#src/lib/tmux.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState, writeTestConfig } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("session.create dedupe / liveness / staleness", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string | undefined;

  beforeEach(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-create-"));
    sid = undefined;
  });

  afterEach(async () => {
    if (sid) {
      try {
        await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
      } catch {
        /* Best-effort */
      }
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collapses two concurrent creates into one session and layout (D3)", async () => {
    const port = await getFreePort();
    const configPath = writeTestConfig(tmpDir, port);
    const params = {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    };

    // Fire both creates in the same tick — they must share one in-flight build.
    const [res1, res2] = await Promise.all([
      ipcRequest(daemon.socketPath, "session.create", params),
      ipcRequest(daemon.socketPath, "session.create", params),
    ]);
    sid = (res1.result as { id: string }).id;

    expect(res1.error).toBeUndefined();
    expect(res2.error).toBeUndefined();
    expect((res2.result as { id: string }).id).toBe(sid);

    // Exactly one session exists, with one pane per service (no doubled layout).
    const listRes = await ipcRequest(daemon.socketPath, "session.list");
    expect((listRes.result as unknown[]).length).toBe(1);
  });

  it("rebuilds a fresh session when the @tui pane was killed externally (A4)", async () => {
    const port = await getFreePort();
    const configPath = writeTestConfig(tmpDir, port);

    const firstRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (firstRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    // Simulate the user closing the window: kill the service pane, then re-up
    // From a brand-new pane. The dead @tui pane must trigger a clean rebuild.
    const firstPaneMap = (firstRes.result as { paneMap: Record<string, string> }).paneMap;
    await killPane(firstPaneMap.web).catch(() => {
      /* May already be gone */
    });

    const tmux2 = await createTestSession();
    try {
      // Force the cached @tui pane to read as dead by killing it.
      await killPane(firstPaneMap["@tui"]).catch(() => {
        /* Best-effort */
      });

      const secondRes = await ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: tmpDir,
        tmuxSession: tmux2.name,
        originPane: tmux2.initialPaneId,
      });
      sid = (secondRes.result as { id: string }).id;
      const secondPaneMap = (secondRes.result as { paneMap: Record<string, string> }).paneMap;

      // Fresh layout bound to the new origin pane — never the dead one.
      expect(secondPaneMap["@tui"]).toBe(tmux2.initialPaneId);
      expect(secondPaneMap["@tui"]).not.toBe(firstPaneMap["@tui"]);
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");
    } finally {
      await tmux2.cleanup();
    }
  });

  it("emits session.configStale within ~10-12s after the config is touched (A4)", async () => {
    const port = await getFreePort();
    const configPath = writeTestConfig(tmpDir, port);

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (createRes.result as { id: string }).id;
    await waitForServiceState(daemon.socketPath, sid, "web", "ready");

    const events: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["session.*"], (event) => {
      events.push(event);
    });
    // Confirm the subscription is live (and the staleness poll is armed).
    await ipcRequest(daemon.socketPath, "daemon.ping");

    // Bump the config mtime into the future so it is unambiguously newer than
    // The load timestamp, then wait for the next 10s poll to notice.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(configPath, future, future);

    const deadline = Date.now() + 12_000;
    let staleEvent: DaemonEvent | undefined;
    /* eslint-disable no-await-in-loop -- polling for the event */
    while (!staleEvent && Date.now() < deadline) {
      staleEvent = events.find((e) => e.event === "session.configStale");
      if (!staleEvent) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    /* eslint-enable no-await-in-loop */
    sub.close();

    expect(staleEvent).toBeDefined();
    expect((staleEvent!.data as { configStale: boolean }).configStale).toBe(true);
  });
});
