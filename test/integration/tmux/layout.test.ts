import { afterEach, describe, expect, it } from "vitest";

import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { listPanes, tmuxFor } from "#src/lib/tmux.js";
import type { PaneInfo } from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

/** Poll listPanes until expected count or timeout — tmux may lag behind splitPane. */
async function waitForPaneCount(
  sessionName: string,
  expected: number,
  timeoutMs = 5000,
): Promise<PaneInfo[]> {
  const start = Date.now();
  let panes: PaneInfo[] = [];
  while (Date.now() - start < timeoutMs) {
    panes = await listPanes(sessionName);
    if (panes.length === expected) {
      return panes;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return panes;
}

describe.skipIf(!hasTmux())("tmux layout integration", () => {
  let session: TestSession;

  afterEach(async () => {
    await session.cleanup();
  });

  it("no layout → auto-split creates @tui + service panes", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
      worker: { start: "echo worker" },
    };

    const { paneMap } = await createLayout(session.initialPaneId, undefined, services, undefined, {
      tmux: tmuxFor(testTmuxSocket()),
    });
    const panes = await waitForPaneCount(session.name, 3);

    expect(panes).toHaveLength(3);
    expect(paneMap["@tui"]).toBe(session.initialPaneId);
    expect(paneMap.api).toBeDefined();
    expect(paneMap.worker).toBeDefined();
  });

  it("detached service skips pane", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
      bg: { start: "echo bg", detached: true },
    };

    const { paneMap } = await createLayout(session.initialPaneId, undefined, services, undefined, {
      tmux: tmuxFor(testTmuxSocket()),
    });
    const panes = await waitForPaneCount(session.name, 2);

    expect(panes).toHaveLength(2);
    expect(paneMap["@tui"]).toBeDefined();
    expect(paneMap.api).toBeDefined();
    expect(paneMap.bg).toBeUndefined();
  });

  it("rows layout creates correct panes", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
    };
    const layout: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const { paneMap } = await createLayout(session.initialPaneId, layout, services, undefined, {
      tmux: tmuxFor(testTmuxSocket()),
    });
    const panes = await waitForPaneCount(session.name, 2);

    expect(panes).toHaveLength(2);
    expect(paneMap["@tui"]).toBeDefined();
    expect(paneMap.api).toBeDefined();
  });

  it("nested layout (columns + rows)", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
      fe: { start: "echo fe" },
    };
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        {
          direction: "rows",
          children: [
            { pane: "api", size: "50%" },
            { pane: "fe", size: "50%" },
          ],
          size: "70%",
        },
      ],
    };

    const { paneMap } = await createLayout(session.initialPaneId, layout, services, undefined, {
      tmux: tmuxFor(testTmuxSocket()),
    });
    const panes = await waitForPaneCount(session.name, 3);

    expect(panes).toHaveLength(3);
    expect(paneMap["@tui"]).toBeDefined();
    expect(paneMap.api).toBeDefined();
    expect(paneMap.fe).toBeDefined();
  });

  it("services not in layout get auto-split panes", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
      worker: { start: "echo worker" },
    };
    const layout: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const { paneMap } = await createLayout(session.initialPaneId, layout, services, undefined, {
      tmux: tmuxFor(testTmuxSocket()),
    });
    const panes = await waitForPaneCount(session.name, 3);

    // @tui + api from layout + worker auto-split
    expect(panes).toHaveLength(3);
    expect(paneMap.worker).toBeDefined();
    expect(paneMap.worker).not.toBe(paneMap["@tui"]);
    expect(paneMap.worker).not.toBe(paneMap.api);
  });

  it("focus pane selection", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
    };
    const layout: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%", focus: true },
      ],
    };

    const { paneMap, focusPane } = await createLayout(
      session.initialPaneId,
      layout,
      services,
      undefined,
      { tmux: tmuxFor(testTmuxSocket()) },
    );

    expect(focusPane).toBe(paneMap.api);
  });
});
