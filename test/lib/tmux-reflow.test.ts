import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { LayoutNode } from "../../src/config/types.js";
import { PaneTooSmallError } from "../../src/lib/tmux-layout.js";
import { LayoutReflow, TmuxFailedError } from "../../src/lib/tmux-reflow.js";
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
  windowLayout: Mock<(target: string) => Promise<string>>;
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
    windowLayout: vi.fn<FakeTmux["windowLayout"]>().mockResolvedValue("prior-layout-string"),
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
    windowLayout: tmux.windowLayout,
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
    // The split never produced a pane id, so the rollback only restores prior
    // Geometry — that's exactly ONE selectLayout call (the rollback restore),
    // NOT the productive applyGeometry one (that path was never reached).
    expect(tmux.selectLayout).toHaveBeenCalledTimes(1);
    expect(tmux.selectLayout).toHaveBeenCalledWith("@0", "prior-layout-string");
    expect(tmux.killPane).not.toHaveBeenCalled();
  });

  it("rolls back paneMap when applyGeometry fails after the split succeeded", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const paneMap: PaneMap = { "@tui": "%1" };
    const tmux = makeFakeTmux(["%1", "%99"]);
    tmux.splitPane.mockResolvedValue("%99");
    // The PRODUCTIVE selectLayout (inside applyGeometry) rejects. The ROLLBACK
    // SelectLayout (restoring prior layout) succeeds — so the second call
    // Doesn't reject and the original error rethrows uncovered.
    tmux.selectLayout.mockRejectedValueOnce(new Error("tmux: select-layout failed"));
    const onPaneInserted = vi.fn();
    const onPaneInsertFailed = vi.fn();
    const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInserted, onPaneInsertFailed });

    await expect(reflow.insertPane("api")).rejects.toThrow(/select-layout failed/);
    // The session hook DID fire (paneMap was momentarily set), but the rollback
    // Removed the entry to keep the paneMap-⊇-visible invariant honest.
    expect(onPaneInserted).toHaveBeenCalledWith("api", "%99");
    expect(paneMap.api).toBeUndefined();
    // Round-7 buffer-leak fix: onPaneInsertFailed fires so the session can free
    // The just-allocated paneBuffers[%99] + monitor key.
    expect(onPaneInsertFailed).toHaveBeenCalledWith("api", "%99");
    // The dangling new pane is killed so the prior layout string can apply.
    expect(tmux.killPane).toHaveBeenCalledWith("%99");
    // ROLLBACK selectLayout restored the snapshotted prior layout.
    expect(tmux.selectLayout).toHaveBeenLastCalledWith("@0", "prior-layout-string");
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

describe("LayoutReflow rollback (P03-T04)", () => {
  const layout: LayoutNode = {
    direction: "columns",
    children: [{ pane: "@tui" }, { pane: "api" }],
  };

  describe("insertPane fault injection", () => {
    it("captures windowLayout BEFORE the split (rollback can restore it)", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1", "%99"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      const { reflow } = makeReflow(layout, paneMap, tmux);

      await reflow.insertPane("api");

      // SnapshotPrior was captured before any mutation, even though the happy
      // Path doesn't restore it.
      const [splitCallIdx] = tmux.splitPane.mock.invocationCallOrder;
      const [windowLayoutCallIdx] = tmux.windowLayout.mock.invocationCallOrder;
      expect(windowLayoutCallIdx).toBeLessThan(splitCallIdx);
    });

    it("on split failure: restores prior layout, paneMap untouched, throws TmuxFailedError", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      const splitErr = new Error("tmux: split-window failed");
      tmux.splitPane.mockRejectedValue(splitErr);
      const onPaneInsertFailed = vi.fn();
      const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInsertFailed });

      let thrown: unknown;
      try {
        await reflow.insertPane("api");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TmuxFailedError);
      if (thrown instanceof TmuxFailedError) {
        expect(thrown.code).toBe("TMUX_FAILED");
        expect(thrown.cause).toBe(splitErr);
        expect(thrown.message).toMatch(/split-window failed/);
      }
      // Restore happened.
      expect(tmux.selectLayout).toHaveBeenCalledWith("@0", "snapshot-prior");
      // No pane to kill / no hook to fire — newPaneId was never set.
      expect(tmux.killPane).not.toHaveBeenCalled();
      expect(onPaneInsertFailed).not.toHaveBeenCalled();
      expect(paneMap.api).toBeUndefined();
    });

    it("on applyGeometry failure: kills new pane, fires onPaneInsertFailed, restores prior", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1", "%99"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.splitPane.mockResolvedValue("%99");
      // First selectLayout (productive applyGeometry) fails; rollback selectLayout succeeds.
      tmux.selectLayout.mockRejectedValueOnce(new Error("tmux: select-layout rejected the layout"));
      const onPaneInsertFailed = vi.fn();
      const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInsertFailed });

      await expect(reflow.insertPane("api")).rejects.toBeInstanceOf(TmuxFailedError);

      expect(paneMap.api).toBeUndefined(); // PaneMap rolled back.
      expect(onPaneInsertFailed).toHaveBeenCalledWith("api", "%99"); // Buffer-leak fix.
      expect(tmux.killPane).toHaveBeenCalledWith("%99"); // Dangling pane killed.
      // Two selectLayout calls: the failed productive one + the restore.
      expect(tmux.selectLayout).toHaveBeenCalledTimes(2);
      expect(tmux.selectLayout).toHaveBeenLastCalledWith("@0", "snapshot-prior");
    });

    it("on swap-pane failure during applyGeometry: full rollback (kill + restore)", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%99", "%1"]); // Wrong order — applyGeometry will swap.
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.splitPane.mockResolvedValue("%99");
      tmux.swapPanes.mockRejectedValue(new Error("tmux: swap-pane failed"));
      const onPaneInsertFailed = vi.fn();
      const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInsertFailed });

      await expect(reflow.insertPane("api")).rejects.toThrow(/swap-pane failed/);

      expect(paneMap.api).toBeUndefined();
      expect(onPaneInsertFailed).toHaveBeenCalledWith("api", "%99");
      expect(tmux.killPane).toHaveBeenCalledWith("%99");
      expect(tmux.selectLayout).toHaveBeenCalledWith("@0", "snapshot-prior");
    });

    it("PaneTooSmallError passes through unwrapped (not coerced to TmuxFailedError)", async () => {
      // Provoke computeRects → PaneTooSmallError by using a window so small no
      // Two-leaf split fits. ApplyGeometry will throw inside the catch block.
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1", "%99"], { width: 1, height: 1 });
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.splitPane.mockResolvedValue("%99");
      const onPaneInsertFailed = vi.fn();
      const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneInsertFailed });

      let thrown: unknown;
      try {
        await reflow.insertPane("api");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PaneTooSmallError);
      // Rollback still happened.
      expect(tmux.killPane).toHaveBeenCalledWith("%99");
      expect(onPaneInsertFailed).toHaveBeenCalledWith("api", "%99");
      expect(paneMap.api).toBeUndefined();
    });

    it("rollback failures NEVER mask the original error", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1", "%99"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.splitPane.mockResolvedValue("%99");
      // The productive selectLayout AND the rollback selectLayout both fail.
      tmux.selectLayout.mockRejectedValue(new Error("tmux: select-layout failed"));
      // The kill rollback ALSO fails.
      tmux.killPane.mockRejectedValue(new Error("tmux: kill-pane gone"));

      const rollbackErrors: { phase: string; error: unknown }[] = [];
      const { reflow } = makeReflow(layout, paneMap, tmux, {
        onRollbackError: (phase, error) => {
          rollbackErrors.push({ phase, error });
        },
      });

      let thrown: unknown;
      try {
        await reflow.insertPane("api");
      } catch (error) {
        thrown = error;
      }

      // Original error wins. The rethrown error carries the ORIGINAL message,
      // Not "kill-pane gone" or anything from the rollback chain.
      expect(thrown).toBeInstanceOf(TmuxFailedError);
      if (thrown instanceof TmuxFailedError) {
        expect(thrown.message).toMatch(/select-layout failed/);
      }
      // Both rollback failures were reported (phase names).
      const phases = rollbackErrors.map((e) => e.phase);
      expect(phases).toContain("rollback:killPane");
      expect(phases).toContain("rollback:restoreLayout");
    });

    it("a throwing onRollbackError diagnostic does NOT mask the original error", async () => {
      const paneMap: PaneMap = { "@tui": "%1" };
      const tmux = makeFakeTmux(["%1", "%99"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.splitPane.mockResolvedValue("%99");
      tmux.selectLayout.mockRejectedValue(new Error("tmux: select-layout failed"));
      tmux.killPane.mockRejectedValue(new Error("tmux: kill-pane gone"));

      const { reflow } = makeReflow(layout, paneMap, tmux, {
        onRollbackError: () => {
          throw new Error("diagnostic callback exploded");
        },
      });

      await expect(reflow.insertPane("api")).rejects.toThrow(/select-layout failed/);
    });
  });

  describe("removePane fault injection", () => {
    it("on kill-pane failure: paneMap untouched, throws TmuxFailedError", async () => {
      const paneMap: PaneMap = { "@tui": "%1", api: "%2" };
      const tmux = makeFakeTmux(["%1", "%2"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.killPane.mockRejectedValue(new Error("tmux: kill-pane failed"));
      const onPaneRemoved = vi.fn();
      const { reflow } = makeReflow(layout, paneMap, tmux, { onPaneRemoved });

      let thrown: unknown;
      try {
        await reflow.removePane("api");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TmuxFailedError);
      if (thrown instanceof TmuxFailedError) {
        expect(thrown.phase).toBe("removePane:killPane");
      }
      // Window was never mutated, so the snapshotted prior is not re-applied
      // (no need — nothing changed).
      expect(tmux.selectLayout).not.toHaveBeenCalled();
      expect(paneMap.api).toBe("%2");
      expect(onPaneRemoved).not.toHaveBeenCalled();
    });

    it("on applyGeometry failure after kill: reconciles paneMap against live state", async () => {
      // Setup: 3-pane layout. Removing `api` (%2) succeeds (kill goes through),
      // But the post-kill applyGeometry's selectLayout rejects. The rollback's
      // ReconcilePaneMap pass reads paneIndexOrder and drops any paneMap entry
      // Pointing at a dead pane id (here: a stale %2 wouldn't be in paneMap any
      // More, but a parallel kill could create one — we simulate by returning a
      // Live order missing one of the survivors).
      const threeLayout: LayoutNode = {
        direction: "columns",
        children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
      };
      const paneMap: PaneMap = { "@tui": "%1", api: "%2", web: "%3" };
      const tmux = makeFakeTmux(["%1", "%3"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      tmux.selectLayout.mockRejectedValue(new Error("tmux: select-layout failed"));
      // Simulate a concurrent kill that took web (%3) too.
      tmux.paneIndexOrder.mockResolvedValueOnce([
        { index: 1, id: "%1" },
        { index: 2, id: "%3" },
      ]);
      // Reconciliation pass: live = only %1.
      tmux.paneIndexOrder.mockResolvedValueOnce([{ index: 1, id: "%1" }]);
      const { reflow } = makeReflow(threeLayout, paneMap, tmux);

      await expect(reflow.removePane("api")).rejects.toBeInstanceOf(TmuxFailedError);

      // The kill ran (api gone), and reconciliation dropped the dead `web` entry.
      expect(paneMap.api).toBeUndefined();
      expect(paneMap.web).toBeUndefined();
      expect(paneMap["@tui"]).toBe("%1");
      expect(tmux.killPane).toHaveBeenCalledWith("%2");
    });

    it("rollback failures NEVER mask the original error (remove path)", async () => {
      const threeLayout: LayoutNode = {
        direction: "columns",
        children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
      };
      const paneMap: PaneMap = { "@tui": "%1", api: "%2", web: "%3" };
      const tmux = makeFakeTmux(["%1", "%3"]);
      tmux.windowLayout.mockResolvedValue("snapshot-prior");
      // Productive applyGeometry selectLayout fails (the ORIGINAL error).
      tmux.selectLayout.mockRejectedValue(new Error("tmux: select-layout failed"));
      // ApplyGeometry's paneIndexOrder succeeds (so we reach selectLayout); the
      // SECOND paneIndexOrder (rollback's reconciliation) fails.
      tmux.paneIndexOrder.mockReset();
      tmux.paneIndexOrder.mockResolvedValueOnce([
        { index: 1, id: "%1" },
        { index: 2, id: "%3" },
      ]);
      tmux.paneIndexOrder.mockRejectedValue(new Error("tmux: list-panes broke"));

      const rollbackErrors: string[] = [];
      const { reflow } = makeReflow(threeLayout, paneMap, tmux, {
        onRollbackError: (phase) => {
          rollbackErrors.push(phase);
        },
      });

      await expect(reflow.removePane("api")).rejects.toThrow(/select-layout failed/);
      expect(rollbackErrors).toContain("rollback:reconcilePaneMap");
    });
  });
});
