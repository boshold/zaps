import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceConfig } from "../../src/config/types.js";

// Mock tmux functions
vi.mock("../../src/lib/tmux.js", () => ({
  splitPane: vi.fn(),
  killPane: vi.fn(),
}));

import { createLayout, validateLayout, validateLayoutSizes } from "../../src/lib/tmux-layout.js";
import { killPane, splitPane } from "../../src/lib/tmux.js";

const mockSplitPane = vi.mocked(splitPane);
const mockKillPane = vi.mocked(killPane);

let paneCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  paneCounter = 0;

  mockSplitPane.mockImplementation(async () => {
    const id = `%${(paneCounter += 1)}`;
    return id;
  });
  mockKillPane.mockResolvedValue(undefined);
});

describe("createLayout", () => {
  it("no layout: @tui mapped to start pane, each service gets a split pane", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres" },
      api: { start: "npm start" },
    };

    const { paneMap } = await createLayout("%0", undefined, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.db).toBe("%1");
    expect(paneMap.api).toBe("%2");
    expect(mockSplitPane).toHaveBeenCalledTimes(2);
  });

  it("no layout: skips detached services", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres", detached: true },
      api: { start: "npm start" },
    };

    const { paneMap } = await createLayout("%0", undefined, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
    expect(paneMap.db).toBeUndefined();
    expect(mockSplitPane).toHaveBeenCalledTimes(1);
  });

  it("simple 2-pane row layout: one split, correct direction", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
    };

    const layout = {
      direction: "rows" as const,
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
    expect(mockSplitPane).toHaveBeenCalledTimes(1);
    // Direction "rows" maps to "v"
    expect(mockSplitPane).toHaveBeenCalledWith("%0", "v", 50);
  });

  it("nested layout: correct split sequence and pane mapping", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
      frontend: { start: "npm run dev" },
    };

    const layout = {
      direction: "columns" as const,
      children: [
        { pane: "@tui", size: "30%" },
        {
          direction: "rows" as const,
          children: [
            { pane: "api", size: "50%" },
            { pane: "frontend", size: "50%" },
          ],
          size: "70%",
        },
      ],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    expect(paneMap["@tui"]).toBe("%0");
    // First split creates %1 for the right column
    expect(paneMap.api).toBe("%1");
    // Second split creates %2 for frontend within the right column
    expect(paneMap.frontend).toBe("%2");
    expect(mockSplitPane).toHaveBeenCalledTimes(2);
  });

  it("size percentages calculated correctly for 3 children", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "a" },
      web: { start: "b" },
    };

    const layout = {
      direction: "columns" as const,
      children: [
        { pane: "@tui", size: "40%" },
        { pane: "api", size: "30%" },
        { pane: "web", size: "30%" },
      ],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
    expect(paneMap.web).toBe("%2");

    // Child 1 (api): split from %0, remaining = 60, tmux = round(60/100*100) = 60
    expect(mockSplitPane).toHaveBeenNthCalledWith(1, "%0", "h", 60);
    // Child 2 (web): split from %1, remaining = 30, tmux = round(30/60*100) = 50
    expect(mockSplitPane).toHaveBeenNthCalledWith(2, "%1", "h", 50);
  });

  it("services not in layout get split panes", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
      worker: { start: "worker" },
    };

    const layout = {
      direction: "rows" as const,
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
    expect(paneMap.worker).toBe("%2");
    expect(mockSplitPane).toHaveBeenCalledTimes(2);
  });

  it("mixed explicit/implicit sizes: implicit children get remainder", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
    };

    const layout = {
      direction: "rows" as const,
      children: [{ pane: "@tui", size: "60%" }, { pane: "api" }],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");

    // Implicit child gets remainder: 100 - 60 = 40
    // CurrentPaneSize = 100, tmux = round(40/100*100) = 40
    expect(mockSplitPane).toHaveBeenCalledWith("%0", "v", 40);
  });

  it("returns focusPane when a leaf has focus: true", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
    };

    const layout = {
      direction: "rows" as const,
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%", focus: true },
      ],
    };

    const { paneMap, focusPane } = await createLayout("%0", layout, services);

    expect(paneMap.api).toBe("%1");
    expect(focusPane).toBe("%1");
  });

  it("defaults focusPane to @tui when no leaf has focus", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
    };

    const layout = {
      direction: "rows" as const,
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const { paneMap, focusPane } = await createLayout("%0", layout, services);

    expect(focusPane).toBe(paneMap["@tui"]);
  });

  it("no layout: focusPane defaults to @tui", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "npm start" },
    };

    const { paneMap, focusPane } = await createLayout("%0", undefined, services);

    expect(focusPane).toBe(paneMap["@tui"]);
  });

  it("first-leaf service, initial create: service inherits the origin pane", async () => {
    const services: Record<string, ServiceConfig> = { api: { start: "npm start" } };
    const layout = {
      direction: "rows" as const,
      children: [{ pane: "api" }, { pane: "@tui" }],
    };

    const { paneMap } = await createLayout("%0", layout, services);

    // Free mode keeps today's behavior: first leaf inherits the start pane.
    expect(paneMap.api).toBe("%0");
    expect(paneMap["@tui"]).toBe("%1");
  });

  it("first-leaf service, reserved mode: @tui keeps the start pane, service gets the split", async () => {
    const services: Record<string, ServiceConfig> = { api: { start: "npm start" } };
    const layout = {
      direction: "rows" as const,
      children: [{ pane: "api" }, { pane: "@tui" }],
    };

    const { paneMap } = await createLayout("%0", layout, services, undefined, {
      reserveTuiPane: true,
    });

    // The TUI pane (start pane) is never handed to a service on reload (A2).
    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
  });

  it("first-leaf @tui, reserved mode: no swap needed", async () => {
    const services: Record<string, ServiceConfig> = { api: { start: "npm start" } };
    const layout = {
      direction: "rows" as const,
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    const { paneMap } = await createLayout("%0", layout, services, undefined, {
      reserveTuiPane: true,
    });

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap.api).toBe("%1");
  });

  it("kills every created pane when a split fails mid-build, then rethrows", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "a" },
      web: { start: "b" },
    };

    // First split succeeds (%1), second throws.
    let calls = 0;
    mockSplitPane.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return "%1";
      }
      throw new Error("tmux split failed");
    });

    await expect(createLayout("%0", undefined, services)).rejects.toThrow("tmux split failed");

    // The one pane created before the failure is cleaned up (best-effort).
    expect(mockKillPane).toHaveBeenCalledTimes(1);
    expect(mockKillPane).toHaveBeenCalledWith("%1");
  });

  it("unreferenced combined group gets one shared pane for all members", async () => {
    const services: Record<string, ServiceConfig> = { api: { start: "npm start" } };
    const groups = new Map<string, string[]>([["dbgroup", ["dbA", "dbB"]]]);
    const layout = {
      direction: "rows" as const,
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    const { paneMap } = await createLayout("%0", layout, services, groups);

    // One shared pane for the whole group; every member maps to it.
    expect(paneMap.dbgroup).toBe("%2");
    expect(paneMap.dbA).toBe("%2");
    expect(paneMap.dbB).toBe("%2");
    // Exactly two splits: api (%1) + the single shared group pane (%2).
    expect(mockSplitPane).toHaveBeenCalledTimes(2);
  });
});

describe("validateLayout", () => {
  it("throws on unknown pane name", () => {
    const layout = {
      direction: "columns" as const,
      children: [{ pane: "@tui" }, { pane: "unknown" }],
    };

    expect(() => validateLayout(layout, ["api"])).toThrow(
      "Layout references unknown pane 'unknown'",
    );
  });

  it("throws on duplicate pane", () => {
    const layout = {
      direction: "columns" as const,
      children: [{ pane: "@tui" }, { pane: "@tui" }],
    };

    expect(() => validateLayout(layout, ["api"])).toThrow("Duplicate pane '@tui' in layout");
  });

  it("throws when @tui is missing", () => {
    const layout = {
      direction: "columns" as const,
      children: [{ pane: "api" }, { pane: "web" }],
    };

    expect(() => validateLayout(layout, ["api", "web"])).toThrow("Layout must include '@tui' pane");
  });

  it("valid layout does not throw", () => {
    const layout = {
      direction: "columns" as const,
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    expect(() => validateLayout(layout, ["api"])).not.toThrow();
  });

  it("throws when multiple panes have focus", () => {
    const layout = {
      direction: "columns" as const,
      children: [
        { pane: "@tui", focus: true },
        { pane: "api", focus: true },
      ],
    };

    expect(() => validateLayout(layout, ["api"])).toThrow(
      "Only one pane can have focus, found: @tui, api",
    );
  });

  it("allows single focus pane", () => {
    const layout = {
      direction: "columns" as const,
      children: [{ pane: "@tui" }, { pane: "api", focus: true }],
    };

    expect(() => validateLayout(layout, ["api"])).not.toThrow();
  });

  it("rejects a split whose explicit sizes overflow with implicit siblings", () => {
    const layout = {
      direction: "rows" as const,
      children: [{ pane: "@tui", size: "60%" }, { pane: "api", size: "40%" }, { pane: "web" }],
    };

    expect(() => validateLayout(layout, ["api", "web"])).toThrow(/implicit-size panes/);
  });
});

describe("validateLayoutSizes", () => {
  it("rejects explicit sizes summing to 100 when implicit siblings exist", () => {
    const split = {
      direction: "rows" as const,
      children: [{ pane: "a", size: "50%" }, { pane: "b", size: "50%" }, { pane: "c" }],
    };

    expect(() => validateLayoutSizes(split)).toThrow(/implicit-size panes/);
  });

  it("allows explicit sizes summing to 100 when there are no implicit siblings", () => {
    const split = {
      direction: "rows" as const,
      children: [
        { pane: "a", size: "50%" },
        { pane: "b", size: "50%" },
      ],
    };

    expect(() => validateLayoutSizes(split)).not.toThrow();
  });

  it("rejects explicit sizes summing above 100 in any case", () => {
    const split = {
      direction: "rows" as const,
      children: [
        { pane: "a", size: "60%" },
        { pane: "b", size: "50%" },
      ],
    };

    expect(() => validateLayoutSizes(split)).toThrow(/must not exceed 100/);
  });

  it("rejects a layout that computes a split percent below 1", () => {
    const split = {
      direction: "rows" as const,
      children: [
        { pane: "a", size: "50%" },
        { pane: "b", size: "50%" },
        { pane: "c", size: "0%" },
      ],
    };

    expect(() => validateLayoutSizes(split)).toThrow(/below 1%.*'c'/);
  });

  it("allows a valid boundary: 99 explicit + one implicit sibling", () => {
    const split = {
      direction: "rows" as const,
      children: [{ pane: "a", size: "99%" }, { pane: "b" }],
    };

    expect(() => validateLayoutSizes(split)).not.toThrow();
  });

  it("recurses into nested splits", () => {
    const split = {
      direction: "columns" as const,
      children: [
        { pane: "@tui", size: "30%" },
        {
          direction: "rows" as const,
          size: "70%",
          children: [
            { pane: "a", size: "70%" },
            { pane: "b", size: "50%" },
          ],
        },
      ],
    };

    // Inner split sums to 120 > 100.
    expect(() => validateLayoutSizes(split)).toThrow(/must not exceed 100/);
  });

  it("is a no-op for a leaf node", () => {
    expect(() => validateLayoutSizes({ pane: "@tui" })).not.toThrow();
  });
});
