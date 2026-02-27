import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { listPanes } from "#src/lib/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

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

    const { paneMap } = await createLayout(session.initialPaneId, undefined, services);
    const panes = await listPanes(session.name);

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

    const { paneMap } = await createLayout(session.initialPaneId, undefined, services);
    const panes = await listPanes(session.name);

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

    const { paneMap } = await createLayout(session.initialPaneId, layout, services);
    const panes = await listPanes(session.name);

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

    const { paneMap } = await createLayout(session.initialPaneId, layout, services);
    const panes = await listPanes(session.name);

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

    const { paneMap } = await createLayout(session.initialPaneId, layout, services);
    const panes = await listPanes(session.name);

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

    const { paneMap, focusPane } = await createLayout(session.initialPaneId, layout, services);

    expect(focusPane).toBe(paneMap.api);
  });
});
