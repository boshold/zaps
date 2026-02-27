import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceConfig } from "../../src/config/types.js";

// Mock tmux functions
vi.mock("../../src/lib/tmux.js", () => ({
  splitPane: vi.fn(),
}));

import { createLayout, validateLayout } from "../../src/lib/tmux-layout.js";
import { splitPane } from "../../src/lib/tmux.js";

const mockSplitPane = vi.mocked(splitPane);

let paneCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  paneCounter = 0;

  mockSplitPane.mockImplementation(async () => {
    const id = `%${(paneCounter += 1)}`;
    return id;
  });
});

describe("createLayout", () => {
  it("no layout: @tui mapped to start pane, each service gets a split pane", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres" },
      api: { start: "npm start" },
    };

    const { paneMap } = await createLayout("%0", undefined, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap["db"]).toBe("%1");
    expect(paneMap["api"]).toBe("%2");
    expect(mockSplitPane).toHaveBeenCalledTimes(2);
  });

  it("no layout: skips detached services", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres", detached: true },
      api: { start: "npm start" },
    };

    const { paneMap } = await createLayout("%0", undefined, services);

    expect(paneMap["@tui"]).toBe("%0");
    expect(paneMap["api"]).toBe("%1");
    expect(paneMap["db"]).toBeUndefined();
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
    expect(paneMap["api"]).toBe("%1");
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
    expect(paneMap["api"]).toBe("%1");
    // Second split creates %2 for frontend within the right column
    expect(paneMap["frontend"]).toBe("%2");
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
    expect(paneMap["api"]).toBe("%1");
    expect(paneMap["web"]).toBe("%2");

    // Child 1 (api): currentPaneSize = 100, tmux = round(30/100*100) = 30
    expect(mockSplitPane).toHaveBeenNthCalledWith(1, "%0", "h", 30);
    // Child 2 (web): currentPaneSize = 70, tmux = round(30/70*100) = 43
    expect(mockSplitPane).toHaveBeenNthCalledWith(2, "%0", "h", 43);
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
    expect(paneMap["api"]).toBe("%1");
    expect(paneMap["worker"]).toBe("%2");
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
    expect(paneMap["api"]).toBe("%1");

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

    expect(paneMap["api"]).toBe("%1");
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
});
