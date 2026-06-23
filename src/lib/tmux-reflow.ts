import type { LayoutNode } from "#src/config/types.js";

import { computeRects, filterTree, layoutString, resolvePermutation } from "./tmux-layout.js";
import type { Rect } from "./tmux-layout.js";
import {
  getWindowSize as defaultGetWindowSize,
  paneIndexOrder as defaultPaneIndexOrder,
  resyncPaneSizes as defaultResyncPaneSizes,
  selectLayout as defaultSelectLayout,
  swapPanes as defaultSwapPanes,
} from "./tmux.js";

/** Map from pane/service name → tmux pane id (e.g. `"%17"`). */
type PaneMap = Record<string, string>;

/**
 * Deps for `LayoutReflow`. EVERY field is a getter or callback, never a captured
 * value — `session._reload` reassigns `paneMap`/`layout`/`services` to fresh
 * objects, so a ref captured at construction goes stale after the first reload
 * (an insert would then mutate the orphaned old map). Reading through these
 * getters always returns the current Session state. tmux operations are
 * injected too so unit tests can pin behavior without spawning tmux.
 */
interface LayoutReflowDeps {
  /** The declared layout tree (may be undefined when the project has no layout). */
  getLayout: () => LayoutNode | undefined;
  /** Live name → pane-id map; mutated by insert/remove, replaced by reload. */
  getPaneMap: () => PaneMap;
  /** Window target (session, window id, or `@N`) whose geometry we drive. */
  getWindowTarget: () => string;
  /** Current window size; concurrent terminal resize is tolerated by the next reflow. */
  getWindowSize?: (target: string) => Promise<{ width: number; height: number }>;
  /** Live spatial pane order, ascending by `pane_index`. */
  paneIndexOrder?: (target: string) => Promise<{ index: number; id: string }[]>;
  /** Swap two panes' positions without restarting their processes. */
  swapPanes?: (src: string, dst: string) => Promise<void>;
  /** Apply an absolute layout string to the window. */
  selectLayout?: (target: string, layout: string) => Promise<void>;
  /** Fallback resync (no-op by default); the reflow only calls it when explicitly enabled. */
  resyncPaneSizes?: (target: string) => Promise<void>;
}

/** DFS leaf order of `tree`. Mirrors `collectPaneNames` in tmux-layout.ts. */
function collectLeaves(tree: LayoutNode): string[] {
  if ("pane" in tree) {
    return [tree.pane];
  }
  return tree.children.flatMap(collectLeaves);
}

/**
 * Build the `paneNumbers` map for `layoutString`. tmux pane ids look like `"%17"`;
 * the encoded layout-string pane number is the integer portion. Throws on a
 * malformed id (defense in depth — the loader/tmux are the only sources).
 */
function buildPaneNumbers(leafOrder: string[], paneMap: PaneMap): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const name of leafOrder) {
    const id = paneMap[name];
    const match = /^%(?<n>\d+)$/u.exec(id);
    if (!match?.groups) {
      throw new Error(`LayoutReflow: pane id '${id}' for '${name}' is not a '%N' tmux pane id`);
    }
    numbers.set(name, Number.parseInt(match.groups.n, 10));
  }
  return numbers;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, i) => value === b[i]);
}

/** Per-call options. `resyncFallback` is off by default (the no-resync fast path). */
interface ApplyGeometryOptions {
  /**
   * When true, invoke `resyncPaneSizes` AFTER `select-layout` — the gated fallback
   * for the attached-client staleness edge (tmux-query-invisible; can only be
   * resynced, not detected). Default off; the no-resync path is verified on both
   * detached servers and attached pty clients.
   */
  resyncFallback?: boolean;
}

/**
 * Drives an existing tmux window to the exact target geometry for a given set of
 * visible panes — WITHOUT restarting any process. Insert/remove (kill-pane and
 * split) live in P03; this primitive only swaps + select-layouts.
 *
 * Algorithm (`applyGeometry`):
 *  1. `filterTree(layout, visible)` → target tree (visible leaves only, single-
 *     child splits collapsed).
 *  2. `computeRects(tree, w, h)` → absolute cell rects per pane name.
 *  3. Target DFS leaf order → pane ids via `paneMap`.
 *  4. Read live spatial order; if already equal → ZERO swaps (the common adjacency
 *     case). Otherwise emit selection-sort `swap-pane` pairs.
 *  5. Exactly ONE `select-layout` with the serialized layout string.
 *
 * `resyncPaneSizes` is NOT on the default path. `select-layout`/`resize-pane`
 * push correct pty winsizes themselves (verified on detached + attached clients,
 * Round 7); the staleness is a multi-split boot artifact and is invisible to
 * tmux queries. The hook is gated via `ApplyGeometryOptions.resyncFallback` so
 * P02-T03 / P04 can enable it for the attached-client edge.
 */
class LayoutReflow {
  private readonly deps: LayoutReflowDeps;
  private readonly tmux: {
    getWindowSize: (target: string) => Promise<{ width: number; height: number }>;
    paneIndexOrder: (target: string) => Promise<{ index: number; id: string }[]>;
    swapPanes: (src: string, dst: string) => Promise<void>;
    selectLayout: (target: string, layout: string) => Promise<void>;
    resyncPaneSizes: (target: string) => Promise<void>;
  };

  public constructor(deps: LayoutReflowDeps) {
    this.deps = deps;
    // Fill in real tmux wrappers; tests can override any subset via deps.
    this.tmux = {
      getWindowSize: deps.getWindowSize ?? defaultGetWindowSize,
      paneIndexOrder: deps.paneIndexOrder ?? defaultPaneIndexOrder,
      swapPanes: deps.swapPanes ?? defaultSwapPanes,
      selectLayout: deps.selectLayout ?? defaultSelectLayout,
      resyncPaneSizes: deps.resyncPaneSizes ?? defaultResyncPaneSizes,
    };
  }

  /**
   * Drive the window to the geometry implied by `visibleNames` — the set of pane
   * names (incl. `@tui`) that should currently own a tmux pane. Returns when
   * `select-layout` has applied; the (optional) resync fallback runs after.
   *
   * Throws if there is no declared layout (the no-layout path has no geometry to
   * reflow against), if a visible pane is missing from `paneMap` (impossible
   * once Phase-3 lifecycle hooks land — insert/remove keep the map and the
   * visible set in lockstep), or if the filtered tree turns out empty.
   */
  public async applyGeometry(
    visibleNames: Set<string>,
    options?: ApplyGeometryOptions,
  ): Promise<void> {
    const layout = this.deps.getLayout();
    if (!layout) {
      throw new Error("LayoutReflow.applyGeometry: no declared layout to reflow against");
    }

    // 1. Filter to the visible subtree (single-child splits already collapsed).
    const tree = filterTree(layout, visibleNames);
    if (!tree) {
      throw new Error(
        "LayoutReflow.applyGeometry: filtered tree is empty (no visible panes intersect the layout)",
      );
    }

    // 2. Compute absolute cell rects against the live window size.
    const target = this.deps.getWindowTarget();
    const { width, height } = await this.tmux.getWindowSize(target);
    const rects = computeRects(tree, width, height);

    // 3. Target DFS leaf order → pane ids via the LIVE paneMap (post-reload-safe).
    const paneMap = this.deps.getPaneMap();
    const targetLeafOrder = collectLeaves(tree);
    const targetIds = targetLeafOrder.map((name) => {
      const id = paneMap[name];
      if (!id) {
        throw new Error(`LayoutReflow.applyGeometry: pane '${name}' is not in paneMap`);
      }
      return id;
    });

    // 4. Read live spatial order; reorder only if it doesn't already match.
    const currentOrder = await this.tmux.paneIndexOrder(target);
    const currentIds = currentOrder.map((entry) => entry.id);
    if (!arraysEqual(currentIds, targetIds)) {
      const swaps = resolvePermutation(currentIds, targetIds);
      for (const [from, to] of swaps) {
        // Sequential: each swap must complete before the next so paneIndexOrder
        // Would converge on the target. tmux serializes per-server anyway.
        // eslint-disable-next-line no-await-in-loop -- sequential by design
        await this.tmux.swapPanes(from, to);
      }
    }

    // 5. Exactly ONE select-layout with the serialized geometry. Pane numbers
    //    Are the integer part of the `%N` pane id — encoded numbers are cosmetic
    //    For binding (select-layout binds by spatial order), but must be present
    //    And well-formed.
    const paneNumbers = buildPaneNumbers(targetLeafOrder, paneMap);
    await this.tmux.selectLayout(target, layoutString(tree, rects, paneNumbers));

    // 6. Optional fallback for attached-client staleness — invisible to tmux
    //    Queries, so it can only ever be resynced, not detected. Off by default.
    if (options?.resyncFallback) {
      await this.tmux.resyncPaneSizes(target);
    }
  }
}

export { LayoutReflow };
export type { ApplyGeometryOptions, LayoutReflowDeps, PaneMap, Rect };
