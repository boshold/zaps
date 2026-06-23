import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { LayoutNode } from "../../src/config/types.js";
import { LayoutReflow } from "../../src/lib/tmux-reflow.js";
import type { LayoutReflowDeps, PaneMap } from "../../src/lib/tmux-reflow.js";

interface FakeTmux {
  getWindowSize: Mock<(target: string) => Promise<{ width: number; height: number }>>;
  paneIndexOrder: Mock<(target: string) => Promise<{ index: number; id: string }[]>>;
  swapPanes: Mock<(src: string, dst: string) => Promise<void>>;
  selectLayout: Mock<(target: string, layout: string) => Promise<void>>;
  resyncPaneSizes: Mock<(target: string) => Promise<void>>;
}

function makeFakeTmux(spatialOrder: string[], size = { width: 100, height: 30 }): FakeTmux {
  return {
    getWindowSize: vi.fn<FakeTmux["getWindowSize"]>().mockResolvedValue(size),
    paneIndexOrder: vi
      .fn<FakeTmux["paneIndexOrder"]>()
      .mockResolvedValue(spatialOrder.map((id, index) => ({ index: index + 1, id }))),
    swapPanes: vi.fn<FakeTmux["swapPanes"]>().mockResolvedValue(undefined),
    selectLayout: vi.fn<FakeTmux["selectLayout"]>().mockResolvedValue(undefined),
    resyncPaneSizes: vi.fn<FakeTmux["resyncPaneSizes"]>().mockResolvedValue(undefined),
  };
}

function makeReflow(
  layout: LayoutNode | undefined,
  paneMap: PaneMap,
  tmux: FakeTmux,
): { reflow: LayoutReflow; deps: LayoutReflowDeps } {
  const deps: LayoutReflowDeps = {
    getLayout: () => layout,
    getPaneMap: () => paneMap,
    getWindowTarget: () => "@0",
    getWindowSize: tmux.getWindowSize,
    paneIndexOrder: tmux.paneIndexOrder,
    swapPanes: tmux.swapPanes,
    selectLayout: tmux.selectLayout,
    resyncPaneSizes: tmux.resyncPaneSizes,
  };
  return { reflow: new LayoutReflow(deps), deps };
}

describe("LayoutReflow.applyGeometry — order decision", () => {
  const layout: LayoutNode = {
    direction: "columns",
    children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
  };
  const paneMap: PaneMap = { "@tui": "%1", api: "%2", web: "%3" };

  it("skips swap-pane entirely when spatial order already matches target DFS order", async () => {
    const tmux = makeFakeTmux(["%1", "%2", "%3"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    expect(tmux.swapPanes).not.toHaveBeenCalled();
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
  });

  it("emits exactly one selectLayout per applyGeometry", async () => {
    const tmux = makeFakeTmux(["%1", "%2", "%3"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    const [[target, layoutStr]] = tmux.selectLayout.mock.calls;
    expect(target).toBe("@0");
    // Real tmux layout string format: `<checksum>,<body>`.
    expect(typeof layoutStr).toBe("string");
    expect(layoutStr).toMatch(/^[0-9a-f]{4},/u);
  });

  it("emits the resolvePermutation swaps when current order doesn't match target", async () => {
    // Current spatial order is reversed relative to target.
    const tmux = makeFakeTmux(["%3", "%2", "%1"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    // Selection sort over [%3,%2,%1] → [%1,%2,%3] needs one swap (slot 0).
    expect(tmux.swapPanes).toHaveBeenCalledTimes(1);
    expect(tmux.swapPanes).toHaveBeenNthCalledWith(1, "%3", "%1");
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
  });

  it("emits the swaps in selection-sort order for a 3-cycle", async () => {
    // 3-cycle [A,B,C] → [C,A,B] needs 2 swaps.
    const cycleLayout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "C" }, { pane: "A" }, { pane: "B" }],
    };
    const cycleMap: PaneMap = { A: "%1", B: "%2", C: "%3" };
    const tmux = makeFakeTmux(["%1", "%2", "%3"]);
    const { reflow } = makeReflow(cycleLayout, cycleMap, tmux);

    await reflow.applyGeometry(new Set(["A", "B", "C"]));

    expect(tmux.swapPanes).toHaveBeenCalledTimes(2);
    expect(tmux.swapPanes).toHaveBeenNthCalledWith(1, "%1", "%3");
    expect(tmux.swapPanes).toHaveBeenNthCalledWith(2, "%2", "%1");
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
  });

  it("does NOT call resyncPaneSizes on the default path", async () => {
    const tmux = makeFakeTmux(["%1", "%2", "%3"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    expect(tmux.resyncPaneSizes).not.toHaveBeenCalled();
  });

  it("invokes the resync fallback only when explicitly enabled", async () => {
    const tmux = makeFakeTmux(["%1", "%2", "%3"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]), { resyncFallback: true });

    expect(tmux.resyncPaneSizes).toHaveBeenCalledTimes(1);
    expect(tmux.resyncPaneSizes).toHaveBeenCalledWith("@0");
  });
});

describe("LayoutReflow.applyGeometry — filtered visibility", () => {
  it("uses the filtered DFS order (only visible panes contribute swaps)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };
    const paneMap: PaneMap = { "@tui": "%1", web: "%3" }; // Api is hidden, no pane.
    const tmux = makeFakeTmux(["%1", "%3"]); // Already in DFS order: @tui, web.
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.applyGeometry(new Set(["@tui", "web"]));

    expect(tmux.swapPanes).not.toHaveBeenCalled();
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    // The emitted layout string is for a 2-pane, not 3-pane, tree.
    const [[, layoutStr]] = tmux.selectLayout.mock.calls;
    expect(layoutStr).not.toContain(",2,"); // No middle "api" pane number.
  });

  it("throws when a visible pane is missing from paneMap (lifecycle invariant)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const tmux = makeFakeTmux(["%1"]);
    const { reflow } = makeReflow(layout, { "@tui": "%1" }, tmux);

    await expect(reflow.applyGeometry(new Set(["@tui", "api"]))).rejects.toThrow(
      /pane 'api' is not in paneMap/,
    );
    expect(tmux.selectLayout).not.toHaveBeenCalled();
  });

  it("throws when no layout is declared (no geometry to reflow against)", async () => {
    const tmux = makeFakeTmux(["%1"]);
    const { reflow } = makeReflow(undefined, { "@tui": "%1" }, tmux);

    await expect(reflow.applyGeometry(new Set(["@tui"]))).rejects.toThrow(/no declared layout/);
  });

  it("throws when the filtered tree is empty (no visible panes intersect the layout)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const tmux = makeFakeTmux([]);
    const { reflow } = makeReflow(layout, { "@tui": "%1", api: "%2" }, tmux);

    await expect(reflow.applyGeometry(new Set(["nobody"]))).rejects.toThrow(
      /filtered tree is empty/,
    );
  });
});

describe("LayoutReflow — live getters survive Session._reload's paneMap reassignment", () => {
  it("re-reads paneMap on each call (does not capture the constructor-time reference)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    // Two completely different paneMap objects (simulates _reload's reassignment).
    const oldMap: PaneMap = { "@tui": "%1", api: "%2" };
    const newMap: PaneMap = { "@tui": "%10", api: "%20" };
    let live: PaneMap = oldMap;

    const tmux = makeFakeTmux(["%1", "%2"]); // First call.
    const reflow = new LayoutReflow({
      getLayout: () => layout,
      getPaneMap: () => live, // Live getter — survives reassignment.
      getWindowTarget: () => "@0",
      getWindowSize: tmux.getWindowSize,
      paneIndexOrder: tmux.paneIndexOrder,
      swapPanes: tmux.swapPanes,
      selectLayout: tmux.selectLayout,
      resyncPaneSizes: tmux.resyncPaneSizes,
    });

    await reflow.applyGeometry(new Set(["@tui", "api"]));
    const [[, firstLayout]] = tmux.selectLayout.mock.calls;
    expect(firstLayout.includes(",0,0,1,")).toBe(true);
    expect(firstLayout.includes(",2")).toBe(true); // "%2" → encoded pane number 2.

    // Simulate Session._reload: swap the whole paneMap object + tmux pane ids.
    live = newMap;
    tmux.paneIndexOrder.mockResolvedValue([
      { index: 1, id: "%10" },
      { index: 2, id: "%20" },
    ]);

    await reflow.applyGeometry(new Set(["@tui", "api"]));
    // The SECOND select-layout MUST reference the new pane numbers (10, 20),
    // Proving the reflow re-read paneMap rather than hold onto the old one.
    const [, [, secondLayout]] = tmux.selectLayout.mock.calls;
    expect(secondLayout).toMatch(/,10\b/);
    expect(secondLayout).toMatch(/,20\b/);
    expect(secondLayout).not.toMatch(/,1\b/);
    expect(tmux.swapPanes).not.toHaveBeenCalled();
  });

  it("re-reads layout on each call (a reload that swaps the tree is honored)", async () => {
    const oldLayout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const newLayout: LayoutNode = {
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    let live = oldLayout;
    const tmux = makeFakeTmux(["%1", "%2"]);
    const reflow = new LayoutReflow({
      getLayout: () => live,
      getPaneMap: () => ({ "@tui": "%1", api: "%2" }),
      getWindowTarget: () => "@0",
      getWindowSize: tmux.getWindowSize,
      paneIndexOrder: tmux.paneIndexOrder,
      swapPanes: tmux.swapPanes,
      selectLayout: tmux.selectLayout,
      resyncPaneSizes: tmux.resyncPaneSizes,
    });

    await reflow.applyGeometry(new Set(["@tui", "api"]));
    const [[, firstLayout]] = tmux.selectLayout.mock.calls;
    expect(firstLayout.includes("{")).toBe(true); // Columns → `{...}`.
    expect(firstLayout.includes("[")).toBe(false);

    live = newLayout;
    await reflow.applyGeometry(new Set(["@tui", "api"]));
    const [, [, secondLayout]] = tmux.selectLayout.mock.calls;
    expect(secondLayout.includes("[")).toBe(true); // Rows → `[...]`.
    expect(secondLayout.includes("{")).toBe(false);
  });
});
