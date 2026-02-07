import type { ServiceConfig } from "../../src/config/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tmux functions
vi.mock("../../src/lib/tmux.js", () => ({
  newWindow: vi.fn(),
  splitPane: vi.fn(),
  listPanes: vi.fn(),
}));

import { createLayout, validateLayout } from "../../src/lib/tmux-layout.js";
import { newWindow, splitPane, listPanes } from "../../src/lib/tmux.js";

const mockNewWindow = vi.mocked(newWindow);
const mockSplitPane = vi.mocked(splitPane);
const mockListPanes = vi.mocked(listPanes);

let paneCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  paneCounter = 0;

  mockListPanes.mockResolvedValue([{ id: "%0", pid: 1000, width: 120, height: 40 }]);
  mockNewWindow.mockImplementation(async () => {
    const id = `%${(paneCounter += 1)}`;
    return id;
  });
  mockSplitPane.mockImplementation(async () => {
    const id = `%${(paneCounter += 1)}`;
    return id;
  });
});

describe("createLayout", () => {
  it("no layout: @tui mapped to first pane, each service gets a window", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres" },
      api: { start: "npm start" },
    };

    // eslint-disable-next-line no-undefined -- Testing the undefined layout path
    const result = await createLayout("sess", undefined, services);

    expect(result["@tui"]).toBe("%0");
    expect(result["db"]).toBe("%1");
    expect(result["api"]).toBe("%2");
    expect(mockNewWindow).toHaveBeenCalledTimes(2);
  });

  it("no layout: skips detached services", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "postgres", detached: true },
      api: { start: "npm start" },
    };

    // eslint-disable-next-line no-undefined -- Testing the undefined layout path
    const result = await createLayout("sess", undefined, services);

    expect(result["@tui"]).toBe("%0");
    expect(result["api"]).toBe("%1");
    expect(result["db"]).toBeUndefined();
    expect(mockNewWindow).toHaveBeenCalledTimes(1);
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

    const result = await createLayout("sess", layout, services);

    expect(result["@tui"]).toBe("%0");
    expect(result["api"]).toBe("%1");
    expect(mockSplitPane).toHaveBeenCalledTimes(1);
    // Direction "rows" maps to "v"
    expect(mockSplitPane).toHaveBeenCalledWith("%0", "v", 100);
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

    const result = await createLayout("sess", layout, services);

    expect(result["@tui"]).toBe("%0");
    // First split creates %1 for the right column
    expect(result["api"]).toBe("%1");
    // Second split creates %2 for frontend within the right column
    expect(result["frontend"]).toBe("%2");
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

    const result = await createLayout("sess", layout, services);

    expect(result["@tui"]).toBe("%0");
    expect(result["api"]).toBe("%1");
    expect(result["web"]).toBe("%2");

    // Child 1 (api): remaining = 100 - 40 = 60, tmux = round(30/60*100) = 50
    expect(mockSplitPane).toHaveBeenNthCalledWith(1, "%0", "h", 50);
    // Child 2 (web): remaining = 100 - 70 = 30, tmux = round(30/30*100) = 100
    expect(mockSplitPane).toHaveBeenNthCalledWith(2, "%0", "h", 100);
  });

  it("services not in layout get background windows", async () => {
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

    const result = await createLayout("sess", layout, services);

    expect(result["@tui"]).toBe("%0");
    expect(result["api"]).toBe("%1");
    expect(result["worker"]).toBe("%2");
    expect(mockNewWindow).toHaveBeenCalledTimes(1);
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
});
