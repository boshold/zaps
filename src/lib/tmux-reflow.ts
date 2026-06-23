import type { LayoutLeaf, LayoutNode } from "#src/config/types.js";
import { isLayoutLeaf, isLayoutSplit } from "#src/config/types.js";

import {
  computeRects,
  filterTree,
  layoutString,
  resolvePermutation,
  splitAnchor,
} from "./tmux-layout.js";
import type { Rect } from "./tmux-layout.js";
import {
  getWindowSize as defaultGetWindowSize,
  paneIndexOrder as defaultPaneIndexOrder,
  resyncPaneSizes as defaultResyncPaneSizes,
  selectLayout as defaultSelectLayout,
  selectPane as defaultSelectPane,
  splitPane as defaultSplitPane,
  swapPanes as defaultSwapPanes,
} from "./tmux.js";
import type { SplitPaneOptions } from "./tmux.js";

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
  /** Create a new pane by splitting an existing one; returns the new pane id (`%N`). */
  splitPane?: (target: string, direction: "h" | "v", options?: SplitPaneOptions) => Promise<string>;
  /** Move tmux's active pane to `target`. Used for conditional focus after insert. */
  selectPane?: (target: string) => Promise<void>;
  /**
   * Session-provided hook fired AFTER `paneMap[name]` is set during `insertPane`.
   * The session uses this to allocate the log buffer, register the pane in the
   * shared-buffer map, and start the pane monitor (the Round-7 buffer invariant
   * — pre-start writes go to a private buffer; the hook re-points it to the
   * pane-shared buffer so monitor output isn't lost). Optional: when absent
   * (unit tests, headless harnesses), insertPane completes the geometry work
   * without any log-buffer side-effects.
   */
  onPaneInserted?: (name: string, paneId: string) => void;
  /**
   * Session-provided hook fired AFTER `removePane` kills the tmux pane and deletes
   * `paneMap[name]`. P03-T02 wires the real impl (stop monitor, fold buffer); the
   * field is declared here so P03-T01's deps interface is the same one P03-T02
   * extends — both methods share one constructor surface.
   */
  onPaneRemoved?: (name: string, paneId: string) => void;
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

/**
 * Locate the layout leaf with `pane === name` anywhere in `tree`. Returns the
 * declared leaf (so callers can read `focus`/`size`) or `undefined` when the
 * name isn't in the layout — both insert and the `focus` check need this.
 */
function findLeaf(tree: LayoutNode, name: string): LayoutLeaf | undefined {
  if (isLayoutLeaf(tree)) {
    return tree.pane === name ? tree : undefined;
  }
  if (isLayoutSplit(tree)) {
    for (const child of tree.children) {
      const hit = findLeaf(child, name);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/**
 * The split direction of the leaf's PARENT in the filtered target tree —
 * `"h"` for a columns parent (left/right split), `"v"` for a rows parent
 * (top/bottom). Determines which axis `split-window` should split along so
 * the new pane lands on the right side of the boundary and the transient
 * pre-reflow shape already matches the declared layout's axis (geometry is
 * still re-snapped by `applyGeometry`, but a same-axis split avoids a visible
 * mid-frame orientation flip).
 *
 * Returns undefined only when `name` is the root leaf (no parent split) — that
 * case is impossible for `insertPane` because `splitAnchor` already requires
 * `name` to share the tree with at least one other leaf.
 */
function leafParentDirection(tree: LayoutNode, name: string): "h" | "v" | undefined {
  if (isLayoutLeaf(tree)) {
    return undefined;
  }
  if (isLayoutSplit(tree)) {
    for (const child of tree.children) {
      if (isLayoutLeaf(child) && child.pane === name) {
        return tree.direction === "rows" ? "v" : "h";
      }
      const inner = leafParentDirection(child, name);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
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
    splitPane: (
      target: string,
      direction: "h" | "v",
      options?: SplitPaneOptions,
    ) => Promise<string>;
    selectPane: (target: string) => Promise<void>;
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
      splitPane: deps.splitPane ?? defaultSplitPane,
      selectPane: deps.selectPane ?? defaultSelectPane,
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

  /**
   * Create the tmux pane for a currently pane-less service at its declared
   * position. Zero-swap adjacency split — verified in `20_architecture.md`
   * Smoothness: pick a neighbor leaf in the FILTERED target tree (predecessor
   * preferred), split off it with `-d` so focus doesn't move, then snap exact
   * geometry with `applyGeometry`.
   *
   * The `-d` flag is critical: a plain `split-window` makes the new pane active
   * (verified) and subsequent `select-layout`/`swap-pane` keep that activation
   * — focus would jump from whatever the user was looking at to the freshly-
   * inserted background service. With `-d`, the previously-active pane stays
   * active unless the declared layout leaf has `focus: true`, in which case we
   * explicitly `select-pane` AFTER the geometry settles.
   *
   * The service process itself is NOT started here — `insertPane` only manages
   * the pane; the service manager (Phase 4) starts the process and writes into
   * the pane that this method created.
   *
   * Failure semantics: on any error before `paneMap[name]` is set, `paneMap` is
   * untouched. On an error AFTER the split but before geometry settles, the
   * new pane id is removed from `paneMap` so the lifecycle invariant
   * (paneMap ⊇ visible) holds; the dangling tmux pane and a full visual
   * restore are the responsibility of P03-T04 (rollback) — a TODO seam below.
   */
  public async insertPane(name: string): Promise<void> {
    const layout = this.deps.getLayout();
    if (!layout) {
      throw new Error("LayoutReflow.insertPane: no declared layout to insert into");
    }
    if (!findLeaf(layout, name)) {
      throw new Error(
        `LayoutReflow.insertPane: pane '${name}' is not a leaf in the declared layout`,
      );
    }
    const paneMap = this.deps.getPaneMap();
    if (paneMap[name]) {
      throw new Error(`LayoutReflow.insertPane: pane '${name}' already has a tmux pane`);
    }

    // Target visible = current visible (paneMap keys) ∪ {name}. paneMap is the
    // Authoritative source of "currently owns a tmux pane" — @tui is always in
    // It, and Phase-3 lifecycle hooks keep it in lockstep with reality.
    const targetVisible = new Set<string>([...Object.keys(paneMap), name]);
    const targetTree = filterTree(layout, targetVisible);
    if (!targetTree) {
      throw new Error("LayoutReflow.insertPane: filtered target tree is empty");
    }

    // Anchor — predecessor (after) or successor (before) — gives the
    // Adjacency-split that lands the new pane in its DFS slot with zero swaps.
    const anchor = splitAnchor(targetTree, name);
    const anchorName = anchor.mode === "after" ? anchor.predecessor : anchor.successor;
    const anchorPaneId = paneMap[anchorName];
    if (!anchorPaneId) {
      throw new Error(`LayoutReflow.insertPane: anchor pane '${anchorName}' is not in paneMap`);
    }

    // Mirror the parent split axis so the transient pre-reflow shape already
    // Matches the declared orientation; `applyGeometry` snaps the size anyway,
    // But same-axis avoids a mid-frame orientation flip.
    const direction = leafParentDirection(targetTree, name);
    if (!direction) {
      // Defensive: splitAnchor would have thrown when there's no neighbor, so
      // The leaf must have a parent split in `targetTree`.
      throw new Error(
        `LayoutReflow.insertPane: could not determine parent split direction for '${name}'`,
      );
    }

    let newPaneId: string | undefined = undefined;
    try {
      newPaneId = await this.tmux.splitPane(anchorPaneId, direction, {
        detached: true,
        before: anchor.mode === "before",
      });

      // Mutate paneMap THEN fire the hook so the session sees a consistent view
      // (paneMap already contains the new id when it allocates the log buffer).
      paneMap[name] = newPaneId;
      this.deps.onPaneInserted?.(name, newPaneId);

      // Snap exact geometry — common path is zero swaps (adjacency split landed
      // It in the target DFS slot).
      await this.applyGeometry(targetVisible);

      // Conditional focus: only steal focus when the layout explicitly opted
      // In via `focus: true` on this leaf. Read from the ORIGINAL layout (focus
      // Is a declared property, not derived from the filtered tree).
      const leaf = findLeaf(layout, name);
      if (leaf?.focus) {
        await this.tmux.selectPane(newPaneId);
      }
    } catch (error) {
      // TODO(P03-T04): full rollback — kill the dangling tmux pane and restore
      // The pre-insert window_layout so the user never sees a half-applied
      // State. For now we only restore the paneMap invariant; the dangling
      // Pane is left for P03-T04 to clean up.
      if (newPaneId !== undefined && paneMap[name] === newPaneId) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- rollback removes the just-inserted entry
        delete paneMap[name];
      }
      throw error;
    }
  }
}

export { LayoutReflow };
export type { ApplyGeometryOptions, LayoutReflowDeps, PaneMap, Rect };
