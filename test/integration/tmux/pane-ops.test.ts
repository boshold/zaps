import { afterEach, describe, expect, it } from "vitest";

import { getDescendantPids } from "#src/lib/port.js";
import { capturePane, panePid, sendCtrlC, sendKeys, splitPane } from "#src/lib/tmux.js";

import { longRunningCmd } from "../helpers/fixtures.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("tmux pane-ops integration", () => {
  let session: TestSession;

  afterEach(async () => {
    await session.cleanup();
  });

  it("sendKeys + capturePane", async () => {
    session = await createTestSession();
    await sendKeys(session.initialPaneId, "echo hello-world");

    // Wait for command to execute
    await new Promise((resolve) => setTimeout(resolve, 500));

    const output = await capturePane(session.initialPaneId);
    expect(output).toContain("hello-world");
  });

  it("panePid returns valid number", async () => {
    session = await createTestSession();
    const pid = await panePid(session.initialPaneId);

    expect(pid).toBeGreaterThan(0);
    expect(Number.isInteger(pid)).toBe(true);
  });

  it("sendCtrlC stops running process", async () => {
    session = await createTestSession();
    const paneId = await splitPane(session.initialPaneId, "v");

    // Wait for shell to initialize in the new pane before sending commands
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sendKeys(paneId, longRunningCmd());

    // Poll until process starts (generous timeout — shared tmux server under parallel load)
    const rootPid = await panePid(paneId);
    const startDeadline = Date.now() + 30_000;
    let before: number[] = [];
    while (Date.now() < startDeadline) {
      before = await getDescendantPids(rootPid);
      if (before.length > 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(before.length).toBeGreaterThan(1);

    await sendCtrlC(paneId);

    // Poll until process exits (generous timeout)
    let after: number[] = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      after = await getDescendantPids(rootPid);
      if (after.length <= 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(after.length).toBeLessThanOrEqual(1);
  });

  it("capturePane with line limit", async () => {
    session = await createTestSession();

    // Send several lines
    for (let i = 0; i < 5; i += 1) {
      await sendKeys(session.initialPaneId, `echo line-${i}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const full = await capturePane(session.initialPaneId, 100);
    const limited = await capturePane(session.initialPaneId, 3);

    const fullLines = full.split("\n").filter((l) => l.trim());
    const limitedLines = limited.split("\n").filter((l) => l.trim());

    expect(limitedLines.length).toBeLessThanOrEqual(fullLines.length);
  });
});
