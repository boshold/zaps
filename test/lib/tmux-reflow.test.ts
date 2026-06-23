import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { LayoutNode } from "../../src/config/types.js";
import { LayoutReflow } from "../../src/lib/tmux-reflow.js";
import type { LayoutReflowDeps, PaneMap } from "../../src/lib/tmux-reflow.js";
import type { SplitPaneOptions } from "../../src/lib/tmux.js";

interface FakeTmux {
  getWindowSize: Mock<(target: string) => Promise<{ width: number; height: number }>>;
  paneIndexOrder: Mock<(target: string) => Promise<{ index: number; id: string }[]>>;
  swapPanes: Mock<(src: string, dst: string) => Promise<void>>;
  selectLayout: Mock<(target: string, layout: string) => Promise<void>>;
  resyncPaneSizes: Mock<(target: string) => Promise<void>>;
  splitPane: Mock<
    (target: string, direction: "h" | "v", options?: SplitPaneOptions) => Promise<string>
  >;
  selectPane: Mock<(target: string) => Promise<void>>;
  killPane: Mock<(target: string) => Promise<void>>;
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
    splitPane: vi.fn<FakeTmux["splitPane"]>().mockResolvedValue("%99"),
    selectPane: vi.fn<FakeTmux["selectPane"]>().mockResolvedValue(undefined),
    killPane: vi.fn<FakeTmux["killPane"]>().mockResolvedValue(undefined),
  };
}

function makeReflow(
  layout: LayoutNode | undefined,
  paneMap: PaneMap,
  tmux: FakeTmux,
  extra: Partial<LayoutReflowDeps> = {},
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
    splitPane: tmux.splitPane,
    selectPane: tmux.selectPane,
    killPane: tmux.killPane,
    ...extra,
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

describe("LayoutReflow.insertPane — zero-swap adjacency split", () => {
  it("splits off the predecessor with -d for a middle insert", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };
    const paneMap: PaneMap = { "@tui": "%1", web: "%3" }; // Api currently pane-less.
    // Post-split spatial order = target DFS order → zero swaps in applyGeometry.
    const tmux = makeFakeTmux(["%1", "%99", "%3"]);
    tmux.splitPane.mockResolvedValue("%99");
    const onPaneInserted = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInserted });

    await reflow.insertPane("api");

    // Split off the PREDECESSOR (@tui = %1) with detached + columns axis (-h).
    expect(tmux.splitPane).toHaveBeenCalledTimes(1);
    expect(tmux.splitPane).toHaveBeenCalledWith("%1", "h", {
      detached: true,
      before: false,
    });
    // PaneMap updated.
    expect(paneMap.api).toBe("%99");
    // Hook fired with (name, paneId).
    expect(onPaneInserted).toHaveBeenCalledTimes(1);
    expect(onPaneInserted).toHaveBeenCalledWith("api", "%99");
    // ApplyGeometry ran exactly one selectLayout afterwards.
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    expect(tmux.swapPanes).not.toHaveBeenCalled();
    // No focus stolen (leaf has no focus:true).
    expect(tmux.selectPane).not.toHaveBeenCalled();
  });

  it("uses successor + before:true when inserting at the first position", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "api" }, { pane: "@tui" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%99", "%1"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.insertPane("api");

    expect(tmux.splitPane).toHaveBeenCalledWith("%1", "h", {
      detached: true,
      before: true,
    });
    expect(paneMap.api).toBe("%99");
  });

  it("mirrors the parent split axis — rows → 'v', columns → 'h'", async () => {
    const layout: LayoutNode = {
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.insertPane("api");

    expect(tmux.splitPane).toHaveBeenCalledWith("%1", "v", {
      detached: true,
      before: false,
    });
  });

  it("calls applyGeometry with the target visible set (current ∪ {name})", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };
    const paneMap: PaneMap = { "@tui": "%1", web: "%3" };
    const tmux = makeFakeTmux(["%1", "%99", "%3"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.insertPane("api");

    // SelectLayout layout string is the body of applyGeometry's work; since
    // The fake's spatialOrder = target DFS order, zero swaps happened, and the
    // ONE selectLayout proves applyGeometry ran over the {@tui, api, web} set.
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    const [[, layoutStr]] = tmux.selectLayout.mock.calls;
    // Encoded pane numbers 1, 99, 3 (from paneMap) must appear in DFS order.
    expect(layoutStr).toMatch(/,1\b.*,99\b.*,3\b/u);
  });

  it("moves focus to the new pane only when the layout leaf has focus:true", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api", focus: true }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.insertPane("api");

    expect(tmux.selectPane).toHaveBeenCalledTimes(1);
    expect(tmux.selectPane).toHaveBeenCalledWith("%99");
  });

  it("leaves the previously active pane active when focus:true is absent", async () => {
    // Already covered above but pinned explicitly here so a future regression
    // That defaults focus=true is impossible to ship.
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.insertPane("api");

    expect(tmux.selectPane).not.toHaveBeenCalled();
  });

  it("hook is optional — insertPane completes without onPaneInserted", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    const { reflow } = makeReflow(layout, paneMap, tmux); // No onPaneInserted.

    await expect(reflow.insertPane("api")).resolves.toBeUndefined();
    expect(paneMap.api).toBe("%99");
  });

  it("leaves paneMap unchanged when the split itself fails", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1"]);
    tmux.splitPane.mockRejectedValue(new Error("tmux: split-window failed"));
    const onPaneInserted = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInserted });

    await expect(reflow.insertPane("api")).rejects.toThrow(/split-window failed/);
    expect(paneMap.api).toBeUndefined();
    expect(onPaneInserted).not.toHaveBeenCalled();
    expect(tmux.selectLayout).not.toHaveBeenCalled();
  });

  it("rolls back paneMap when applyGeometry fails after the split succeeded", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    tmux.selectLayout.mockRejectedValue(new Error("tmux: select-layout failed"));
    const onPaneInserted = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInserted });

    await expect(reflow.insertPane("api")).rejects.toThrow(/select-layout failed/);
    // The session hook DID fire (paneMap was momentarily set), but the rollback
    // Removed the entry to keep the paneMap-⊇-visible invariant honest.
    expect(onPaneInserted).toHaveBeenCalledWith("api", "%99");
    expect(paneMap.api).toBeUndefined();
  });

  it("throws when the pane already has a tmux pane", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1", "%2"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await expect(reflow.insertPane("api")).rejects.toThrow(/already has a tmux pane/);
    expect(tmux.splitPane).not.toHaveBeenCalled();
  });

  it("throws when the pane is not declared in the layout", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await expect(reflow.insertPane("unknown")).rejects.toThrow(
      /is not a leaf in the declared layout/,
    );
    expect(tmux.splitPane).not.toHaveBeenCalled();
  });

  it("throws when there is no declared layout", async () => {
    const tmux = makeFakeTmux([]);
    const { reflow } = makeReflow(undefined, { "@tui": "%1" }, tmux);

    await expect(reflow.insertPane("api")).rejects.toThrow(/no declared layout/);
  });
});

describe("LayoutReflow.removePane — kill + re-expand survivors", () => {
  const layout: LayoutNode = {
    direction: "columns",
    children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
  };

  it("kills the pane, deletes the paneMap entry, and re-expands survivors", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2", web: "%3" };
    // After kill, survivors in DFS order = [%1, %3] → zero swaps in applyGeometry.
    const tmux = makeFakeTmux(["%1", "%3"]);
    const onPaneRemoved = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneRemoved });

    await reflow.removePane("api");

    // Kill with the pre-delete pane id.
    expect(tmux.killPane).toHaveBeenCalledTimes(1);
    expect(tmux.killPane).toHaveBeenCalledWith("%2");
    // PaneMap entry removed.
    expect(paneMap.api).toBeUndefined();
    expect(paneMap["@tui"]).toBe("%1");
    expect(paneMap.web).toBe("%3");
    // Hook fired with (name, OLD paneId) — captured pre-delete.
    expect(onPaneRemoved).toHaveBeenCalledTimes(1);
    expect(onPaneRemoved).toHaveBeenCalledWith("api", "%2");
    // ApplyGeometry ran ONE selectLayout, ZERO swaps.
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    expect(tmux.swapPanes).not.toHaveBeenCalled();
  });

  it("passes the remaining visible set to applyGeometry (survivors only)", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2", web: "%3" };
    const tmux = makeFakeTmux(["%1", "%3"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await reflow.removePane("api");

    // The select-layout body should encode pane numbers 1 and 3 (the survivors),
    // And NOT contain pane number 2 (the just-killed `api`).
    const [[, layoutStr]] = tmux.selectLayout.mock.calls;
    expect(layoutStr).toMatch(/,1\b/u);
    expect(layoutStr).toMatch(/,3\b/u);
    expect(layoutStr).not.toMatch(/,2\b/u);
  });

  it("is idempotent — no-op when the name has no pane in paneMap", async () => {
    const paneMap: PaneMap = { "@tui": "%1" }; // No `api` entry.
    const tmux = makeFakeTmux(["%1"]);
    const onPaneRemoved = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneRemoved });

    await expect(reflow.removePane("api")).resolves.toBeUndefined();

    expect(tmux.killPane).not.toHaveBeenCalled();
    expect(onPaneRemoved).not.toHaveBeenCalled();
    expect(tmux.selectLayout).not.toHaveBeenCalled();
    // PaneMap unchanged.
    expect(paneMap).toEqual({ "@tui": "%1" });
  });

  it("refuses to remove the '@tui' pane", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1", "%2"]);
    const { reflow } = makeReflow(layout, paneMap, tmux);

    await expect(reflow.removePane("@tui")).rejects.toThrow(/refusing to remove the '@tui'/);
    // Nothing else fired.
    expect(tmux.killPane).not.toHaveBeenCalled();
    expect(paneMap["@tui"]).toBe("%1");
  });

  it("leaves paneMap untouched on kill-pane failure", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1", "%2"]);
    tmux.killPane.mockRejectedValue(new Error("tmux: kill-pane failed"));
    const onPaneRemoved = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneRemoved });

    await expect(reflow.removePane("api")).rejects.toThrow(/kill-pane failed/);

    // Pre-delete kill failed → paneMap entry still present.
    expect(paneMap.api).toBe("%2");
    expect(onPaneRemoved).not.toHaveBeenCalled();
    expect(tmux.selectLayout).not.toHaveBeenCalled();
  });

  it("hook is optional — removePane completes without onPaneRemoved", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1"]);
    const { reflow } = makeReflow(layout, paneMap, tmux); // No onPaneRemoved.

    await expect(reflow.removePane("api")).resolves.toBeUndefined();
    expect(paneMap.api).toBeUndefined();
  });

  it("captures pane id BEFORE deleting (hook receives the old id, not undefined)", async () => {
    // Regression guard against a refactor that delete-first / fire-second.
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1"]);
    let observedPaneId: string | undefined;
    const onPaneRemoved = vi.fn((name: string, paneId: string) => {
      observedPaneId = paneId;
      // Inside the hook, paneMap.api must already be deleted (the hook fires
      // AFTER the delete) — but `paneId` is the captured pre-delete value.
      expect(paneMap[name]).toBeUndefined();
    });
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneRemoved });

    await reflow.removePane("api");
    expect(observedPaneId).toBe("%2");
  });

  it("throws when no layout is declared (cannot reflow survivors)", async () => {
    const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
    const tmux = makeFakeTmux(["%1"]);
    const { reflow } = makeReflow(undefined, paneMap, tmux);

    await expect(reflow.removePane("api")).rejects.toThrow(/no declared layout/);
    // PaneMap untouched — we bailed before the kill.
    expect(paneMap.api).toBe("%2");
    expect(tmux.killPane).not.toHaveBeenCalled();
  });
});
