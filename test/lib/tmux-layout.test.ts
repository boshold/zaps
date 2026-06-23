import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutNode, ServiceConfig } from "../../src/config/types.js";

// Mock tmux functions
vi.mock("../../src/lib/tmux.js", () => ({
  splitPane: vi.fn(),
  killPane: vi.fn(),
}));

import {
  computeRects,
  createLayout,
  filterTree,
  PaneTooSmallError,
  validateLayout,
  validateLayoutSizes,
} from "../../src/lib/tmux-layout.js";
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

describe("filterTree", () => {
  it("returns undefined for an undefined tree", () => {
    expect(filterTree(undefined, new Set(["@tui"]))).toBeUndefined();
  });

  it("keeps a visible leaf (cloned) and drops an invisible one", () => {
    const leaf: LayoutNode = { pane: "@tui", size: "50%", focus: true };

    const kept = filterTree(leaf, new Set(["@tui"]));
    expect(kept).toEqual({ pane: "@tui", size: "50%", focus: true });
    expect(kept).not.toBe(leaf); // New object, no mutation

    expect(filterTree(leaf, new Set(["api"]))).toBeUndefined();
  });

  it("all-visible: tree is structurally unchanged (and not the same reference)", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui", size: "30%" }, { pane: "api", size: "40%" }, { pane: "web" }],
    };

    const result = filterTree(layout, new Set(["@tui", "api", "web"]));
    expect(result).toEqual(layout);
    expect(result).not.toBe(layout);
  });

  it("does not mutate the input tree", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "70%" },
      ],
    };
    const snapshot = structuredClone(layout);

    filterTree(layout, new Set(["@tui"]));

    expect(layout).toEqual(snapshot);
  });

  it("@tui-only: a flat split collapses to the single surviving leaf", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "40%" },
        { pane: "web", size: "30%" },
      ],
    };

    // The collapsed leaf takes over the whole split slot, so it has no size.
    expect(filterTree(layout, new Set(["@tui"]))).toEqual({ pane: "@tui" });
  });

  it("flat columns, middle child removed: survivors keep their declared sizes", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "40%" },
        { pane: "web", size: "30%" },
      ],
    };

    expect(filterTree(layout, new Set(["@tui", "web"]))).toEqual({
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "web", size: "30%" },
      ],
    });
  });

  it("removed explicit-size sibling: an implicit survivor reclaims the freed space", () => {
    // @tui 70%, api 20%, web implicit (gets remainder 10%). Drop @tui (70%):
    // Api keeps its explicit 20%, web stays implicit and so absorbs the freed
    // Pool — the result is valid computeRects input (explicit 20% < 100, one
    // Implicit sibling), which then resolves web to the remaining 80%.
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui", size: "70%" }, { pane: "api", size: "20%" }, { pane: "web" }],
    };

    const result = filterTree(layout, new Set(["api", "web"]));
    expect(result).toEqual({
      direction: "columns",
      children: [{ pane: "api", size: "20%" }, { pane: "web" }],
    });
    // The survivors remain valid input to computeRects (no overflow).
    expect(() => validateLayoutSizes(result!)).not.toThrow();
  });

  it("nested split fully removed: parent collapses past the empty branch", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        {
          direction: "rows",
          size: "70%",
          children: [
            { pane: "api", size: "50%" },
            { pane: "web", size: "50%" },
          ],
        },
      ],
    };

    // Api+web invisible → inner split drops → outer collapses to @tui leaf.
    expect(filterTree(layout, new Set(["@tui"]))).toEqual({ pane: "@tui" });
  });

  it("collapsing a single-child split: survivor inherits the split's slot size", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        {
          direction: "rows",
          size: "70%",
          children: [
            { pane: "api", size: "50%" },
            { pane: "web", size: "50%" },
          ],
        },
      ],
    };

    // Only web invisible: inner split keeps api (single child) and api takes
    // Over the inner split's 70% slot in the outer columns.
    expect(filterTree(layout, new Set(["@tui", "api"]))).toEqual({
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "70%" },
      ],
    });
  });

  it("deeply nested collapse: survivor inherits the outermost collapsing slot size", () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "40%" },
        {
          direction: "rows",
          size: "60%",
          children: [
            {
              direction: "columns",
              children: [
                { pane: "api", size: "50%" },
                { pane: "worker", size: "50%" },
              ],
            },
            { pane: "web" },
          ],
        },
      ],
    };

    // Keep @tui + api only: worker and web drop, both nested splits collapse,
    // Api bubbles up to the outer 60% slot.
    expect(filterTree(layout, new Set(["@tui", "api"]))).toEqual({
      direction: "columns",
      children: [
        { pane: "@tui", size: "40%" },
        { pane: "api", size: "60%" },
      ],
    });
  });

  it("everything invisible: returns undefined", () => {
    const layout: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    expect(filterTree(layout, new Set())).toBeUndefined();
  });
});

describe("computeRects", () => {
  function sum(values: number[]): number {
    return values.reduce((acc, value) => acc + value, 0);
  }

  it("2-pane columns 80x24: first child takes the rounded-up half", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api", size: "50%" },
      ],
    };

    const rects = computeRects(tree, 80, 24);

    // Captured from live tmux: 80x24 column split → 40 | divider@40 | 39.
    expect(rects.get("@tui")).toEqual({ x: 0, y: 0, width: 40, height: 24 });
    expect(rects.get("api")).toEqual({ x: 41, y: 0, width: 39, height: 24 });
    // Divider accounting: 40 + 39 + 1 divider === 80.
    expect(40 + 39 + 1).toBe(80);
  });

  it("2-pane rows 80x24: first child takes the rounded-up half of the height", () => {
    const tree: LayoutNode = {
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    const rects = computeRects(tree, 80, 24);

    // Content = 24 - 1 = 23; round(23 * 0.5) = 12, last = 11.
    expect(rects.get("@tui")).toEqual({ x: 0, y: 0, width: 80, height: 12 });
    expect(rects.get("api")).toEqual({ x: 0, y: 13, width: 80, height: 11 });
  });

  it("3-pane columns: extents + dividers fill the parent exactly", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };

    const rects = computeRects(tree, 80, 24);

    const widths = ["@tui", "api", "web"].map((name) => rects.get(name)?.width ?? 0);
    // Content = 80 - 2 = 78, three equal implicit shares → 26 each.
    expect(widths).toEqual([26, 26, 26]);
    expect(sum(widths) + 2).toBe(80);
    // Each child offset = previous offset + extent + 1 divider.
    expect(rects.get("@tui")?.x).toBe(0);
    expect(rects.get("api")?.x).toBe(27);
    expect(rects.get("web")?.x).toBe(54);
    // Cross-axis matches the parent.
    for (const name of ["@tui", "api", "web"]) {
      expect(rects.get(name)?.height).toBe(24);
    }
  });

  it("3-level nested layout reproduces the captured tmux geometry (100x30)", () => {
    // Captured string: 100x30,0,0{50x30,0,0,A[49x15,...B{24x14,...C 24x14,...D}]}
    const tree: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "A" },
        {
          direction: "rows",
          children: [
            { pane: "B" },
            {
              direction: "columns",
              children: [{ pane: "C" }, { pane: "D" }],
            },
          ],
        },
      ],
    };

    const rects = computeRects(tree, 100, 30);

    expect(rects.get("A")).toEqual({ x: 0, y: 0, width: 50, height: 30 });
    expect(rects.get("B")).toEqual({ x: 51, y: 0, width: 49, height: 15 });
    expect(rects.get("C")).toEqual({ x: 51, y: 16, width: 24, height: 14 });
    expect(rects.get("D")).toEqual({ x: 76, y: 16, width: 24, height: 14 });
  });

  it("rescales surviving proportions to fill (no gap after a filterTree drop)", () => {
    // FilterTree leaves survivors with their declared percents (here 30% + 30%,
    // Summing to 60 < 100). computeRects MUST normalize them to fill the extent.
    const tree: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "api", size: "30%" },
        { pane: "web", size: "30%" },
      ],
    };

    const rects = computeRects(tree, 80, 24);

    const api = rects.get("api");
    const web = rects.get("web");
    expect(api).toEqual({ x: 0, y: 0, width: 40, height: 24 });
    expect(web).toEqual({ x: 41, y: 0, width: 39, height: 24 });
    // Exactly fills: no leftover gap on the right edge.
    expect((web?.x ?? 0) + (web?.width ?? 0)).toBe(80);
  });

  it("end-to-end with filterTree: dropping a middle child reclaims its space", () => {
    const declared: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "40%" },
        { pane: "web", size: "30%" },
      ],
    };

    const filtered = filterTree(declared, new Set(["@tui", "web"]));
    const rects = computeRects(filtered!, 80, 24);

    // @tui 30% + web 30% rescaled to fill 80 cols with a 1-cell divider.
    const tui = rects.get("@tui");
    const web = rects.get("web");
    expect(tui?.x).toBe(0);
    expect((web?.x ?? 0) + (web?.width ?? 0)).toBe(80);
    expect((tui?.width ?? 0) + (web?.width ?? 0) + 1).toBe(80);
  });

  it("single-leaf tree fills the whole window", () => {
    expect(computeRects({ pane: "@tui" }, 80, 24)).toEqual(
      new Map([["@tui", { x: 0, y: 0, width: 80, height: 24 }]]),
    );
  });

  it("throws PaneTooSmallError naming the pane when an extent < 1", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };

    // Width 2, 3 children → content = 0, every extent collapses below 1.
    let thrown: unknown;
    try {
      computeRects(tree, 2, 24);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaneTooSmallError);
    if (!(thrown instanceof PaneTooSmallError)) {
      throw new Error("expected a PaneTooSmallError");
    }
    expect(thrown.pane).toBe("@tui");
    expect(thrown.code).toBe("PANE_TOO_SMALL");
  });

  it("throws PaneTooSmallError on a zero-height window for a rows split", () => {
    const tree: LayoutNode = {
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    expect(() => computeRects(tree, 80, 0)).toThrow(PaneTooSmallError);
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
