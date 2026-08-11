import type { LayoutLeaf, LayoutNode } from "#src/config/types.js";
import { isLayoutLeaf, isLayoutSplit } from "#src/config/types.js";

import { defaultTmux } from "./tmux-default.js";
import {
  PaneTooSmallError,
  computeRects,
  filterTree,
  layoutString,
  resolvePermutation,
  splitAnchor,
} from "./tmux-layout.js";
import type { Rect } from "./tmux-layout.js";
import type { SplitPaneOptions, TmuxHandle } from "./tmux.js";

/** The tmux commands a reflow issues. */
type ReflowTmux = Pick<
  TmuxHandle,
  | "getWindowSize"
  | "killPane"
  | "paneIndexOrder"
  | "resyncPaneSizes"
  | "selectLayout"
  | "selectPane"
  | "splitPane"
  | "swapPanes"
  | "windowLayout"
>;

/**
 * A tmux command failed during a reflow operation. Wraps the original cause and
 * exposes `code: "TMUX_FAILED"` per `50_api.md`. The `cause` is preserved for
 * diagnostics; `phase` identifies which step of the reflow blew up.
 *
 * `PaneTooSmallError` (from `tmux-layout.ts`) is NOT wrapped — it carries its
 * Own `PANE_TOO_SMALL` semantic and is rethrown as-is so callers can branch on
 * `instanceof PaneTooSmallError` vs `TmuxFailedError`.
 */
class TmuxFailedError extends Error {
  public readonly code = "TMUX_FAILED" as const;
  public readonly phase: string;
  public override readonly cause: unknown;

  public constructor(phase: string, message: string, cause: unknown) {
    super(message);
    this.name = "TmuxFailedError";
    this.phase = phase;
    this.cause = cause;
  }
}

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
  /** Socket-bound tmux surface; per-command overrides below still win. */
  tmux?: ReflowTmux;
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
  /** Destroy a tmux pane (`kill-pane -t <paneId>`). Survivors keep their relative order. */
  killPane?: (target: string) => Promise<void>;
  /** Read live `#{window_layout}` — snapshotted before a reflow mutation so rollback can restore. */
  windowLayout?: (target: string) => Promise<string>;
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
  /**
   * Session-provided hook for insert ROLLBACK: fired when an `insertPane` failure
   * after the split has succeeded needs to undo session-side log allocation.
   * Without it, a failed insert would orphan `paneBuffers[newPaneId]` + a running
   * monitor key — idempotency only covers same-id retry, so a SUBSEQUENT retry
   * with a different pane id would leak the old entry. The session wires this to
   * `freePaneLog(name, paneId)` so the cleanup is symmetric with `onPaneRemoved`.
   */
  onPaneInsertFailed?: (name: string, paneId: string) => void;
  /**
   * Reported when a best-effort rollback step (kill, select-layout, hook) itself
   * fails. Optional. Default behavior: swallow silently (matching `createLayout`'s
   * teardown). Wire this to whatever the host's diagnostic channel is (a daemon
   * event, a metric) — but never let it throw, since rollback errors must NEVER
   * mask the original failure.
   */
  onRollbackError?: (phase: string, error: unknown) => void;
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
  private readonly tmux: ReflowTmux;

  public constructor(deps: LayoutReflowDeps) {
    this.deps = deps;
    // Socket-bound handle (env-based default); tests override any subset via deps.
    const tmux = deps.tmux ?? defaultTmux;
    this.tmux = {
      getWindowSize: deps.getWindowSize ?? tmux.getWindowSize,
      paneIndexOrder: deps.paneIndexOrder ?? tmux.paneIndexOrder,
      swapPanes: deps.swapPanes ?? tmux.swapPanes,
      selectLayout: deps.selectLayout ?? tmux.selectLayout,
      resyncPaneSizes: deps.resyncPaneSizes ?? tmux.resyncPaneSizes,
      splitPane: deps.splitPane ?? tmux.splitPane,
      selectPane: deps.selectPane ?? tmux.selectPane,
      killPane: deps.killPane ?? tmux.killPane,
      windowLayout: deps.windowLayout ?? tmux.windowLayout,
    };
  }

  /**
   * Run `step`; if it throws, report through `onRollbackError` (default swallow)
   * and continue. NEVER lets a rollback failure mask the original error — every
   * use site is inside an outer `catch (original) { ... }` and rethrows
   * `original` last.
   */
  private async tryRollback(phase: string, step: () => Promise<void> | void): Promise<void> {
    try {
      await step();
    } catch (error) {
      try {
        this.deps.onRollbackError?.(phase, error);
      } catch {
        /* The diagnostics callback itself threw — swallow, original error still rethrown */
      }
    }
  }

  /**
   * Wrap an arbitrary unknown thrown value with the typed `TMUX_FAILED` shape,
   * unless it is already a `PaneTooSmallError` or `TmuxFailedError` (those pass
   * through). Preserves the original message so existing message-matching tests
   * keep working, and exposes `cause`/`phase` for downstream consumers.
   */
  private static toTypedError(phase: string, error: unknown): Error {
    if (error instanceof PaneTooSmallError) {
      return error;
    }
    if (error instanceof TmuxFailedError) {
      return error;
    }
    let message = "";
    if (error instanceof Error) {
      ({ message } = error);
    } else if (typeof error === "string") {
      message = error;
    } else {
      message = String(error);
    }
    return new TmuxFailedError(phase, message, error);
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

    // Snapshot the prior window_layout BEFORE mutating. Rollback restores via
    // `selectLayout(target, priorLayout)` — same `select-layout` primitive used
    // For forward progress, mirroring the `createLayout` teardown pattern
    // (`tmux-layout.ts:551-560`). Captured at the LAST possible moment before
    // The split, so it reflects state any in-flight terminal resize has settled.
    const target = this.deps.getWindowTarget();
    let priorLayout: string | undefined = undefined;
    try {
      priorLayout = await this.tmux.windowLayout(target);
    } catch (error) {
      throw LayoutReflow.toTypedError("snapshot:windowLayout", error);
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
      // It in the target DFS slot). Resync unconditionally: an attached client's
      // Pty winsize after a split is tmux-query-invisible (70_risks.md Round 7),
      // So a running TUI (e.g. nuxt dev) keeps drawing at the pre-split width
      // Unless we nudge tmux to re-push every pane's winsize.
      await this.applyGeometry(targetVisible, { resyncFallback: true });

      // Conditional focus: only steal focus when the layout explicitly opted
      // In via `focus: true` on this leaf. Read from the ORIGINAL layout (focus
      // Is a declared property, not derived from the filtered tree).
      const leaf = findLeaf(layout, name);
      if (leaf?.focus) {
        await this.tmux.selectPane(newPaneId);
      }
    } catch (error) {
      // Best-effort rollback. ORDER MATTERS:
      //  1. Roll back the paneMap mutation (if it was made) so any consumer
      //     Reading paneMap during/after this throw sees the pre-insert state.
      //  2. Free the session's log allocation for newPaneId — the
      //     `onPaneInsertFailed` hook closes the buffer/monitor leak: without
      //     This, a later retry with a DIFFERENT paneId would orphan
      //     `paneBuffers[oldId]` + a running monitor key (idempotency only
      //     Covers same-id retry).
      //  3. Kill the just-created tmux pane so the prior layout string (which
      //     Doesn't reference it) can be applied cleanly.
      //  4. Restore prior geometry. The user never sees a half-applied state.
      // Every rollback step is wrapped in `tryRollback` — they cannot mask the
      // Original error.
      if (newPaneId !== undefined && paneMap[name] === newPaneId) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- rollback removes the just-inserted entry
        delete paneMap[name];
      }
      if (newPaneId !== undefined) {
        const createdPaneId = newPaneId;
        await this.tryRollback("rollback:onPaneInsertFailed", () => {
          this.deps.onPaneInsertFailed?.(name, createdPaneId);
        });
        await this.tryRollback("rollback:killPane", async () => {
          await this.tmux.killPane(createdPaneId);
        });
      }
      if (priorLayout !== undefined) {
        await this.tryRollback("rollback:restoreLayout", async () => {
          await this.tmux.selectLayout(target, priorLayout);
        });
      }
      throw LayoutReflow.toTypedError("insertPane", error);
    }
  }

  /**
   * Destroy the tmux pane for an explicitly-stopped service and re-expand the
   * survivors to their declared geometry — Flow C in `10_functional.md`.
   * Killing one pane leaves the survivors in their relative DFS order, so this
   * is `kill-pane` + ONE `applyGeometry`; no `swap-pane` is ever needed.
   *
   * Idempotent: a no-op when `name` is not in `paneMap` (the caller may invoke
   * it from `stopServiceInternal` without first checking pane ownership).
   * Refuses to remove the `@tui` pane — it is the TUI host and must always
   * own a tmux pane while the session is alive.
   *
   * Buffer retention (Round 7 invariant): the `onPaneRemoved` hook stops the
   * monitor and drops the pane-keyed entries (`paneBuffers`/`paneMembers`),
   * but the SERVICE-keyed `buffers[name]` entry is intentionally retained so
   * `logs.snapshot(name)` still returns the stopped service's history and
   * `attachSnapshot` continues to surface it — the same behavior as any
   * normal stopped service. This method only fires the hook; the real
   * buffer/monitor wiring lands in P03-T03.
   *
   * Failure semantics: on `kill-pane` failure, `paneMap` is untouched (we
   * never reached the delete). On a later `applyGeometry` failure the tmux
   * pane is already gone, so `paneMap` stays deleted (the invariant
   * paneMap ⊇ visible already holds — visible no longer contains `name`).
   * Full visual rollback is the responsibility of P03-T04.
   */
  public async removePane(name: string): Promise<void> {
    if (name === "@tui") {
      throw new Error("LayoutReflow.removePane: refusing to remove the '@tui' pane");
    }

    const paneMap = this.deps.getPaneMap();
    const paneId = paneMap[name];
    if (!paneId) {
      // Idempotent — nothing to do for a service that doesn't own a pane.
      return;
    }

    const layout = this.deps.getLayout();
    if (!layout) {
      throw new Error("LayoutReflow.removePane: no declared layout to reflow against");
    }

    // Snapshot the prior window_layout BEFORE killing. After the kill, the
    // String literally references a dead pane id, so we can't re-apply it —
    // The snapshot is kept for diagnostics + the `onRollbackError` channel.
    // Real geometry repair after a kill-then-reflow failure has to come from
    // A reconciliation pass against the LIVE pane order (see catch below).
    const target = this.deps.getWindowTarget();
    let priorLayout: string | undefined = undefined;
    try {
      priorLayout = await this.tmux.windowLayout(target);
    } catch (error) {
      throw LayoutReflow.toTypedError("snapshot:windowLayout", error);
    }

    // Kill first — every other step assumes the pane is gone. On kill-pane
    // Failure, `paneMap` is untouched and we surface the typed error directly:
    // The window is unchanged so there is nothing to roll back.
    try {
      await this.tmux.killPane(paneId);
    } catch (error) {
      throw LayoutReflow.toTypedError("removePane:killPane", error);
    }

    // Capture pane id BEFORE deleting so the hook can stop the monitor by id.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing the just-killed entry
    delete paneMap[name];
    this.deps.onPaneRemoved?.(name, paneId);

    // Re-expand survivors. If geometry fails, paneMap already reflects reality
    // (the killed pane is gone; survivors are still alive and mapped), so the
    // Only "rollback" possible is best-effort reconciliation — see below.
    try {
      const remainingVisible = new Set<string>(Object.keys(paneMap));
      // Same Round-7 reason as insertPane: removing a pane resizes its siblings,
      // And the survivors' pty winsizes may stay stale for an attached client.
      await this.applyGeometry(remainingVisible, { resyncFallback: true });
    } catch (error) {
      await this.tryRollback("rollback:reconcilePaneMap", async () => {
        await this.reconcilePaneMap(target);
      });
      // PriorLayout is reported (not applied — it references the dead pane).
      // The host can use it to assess what was lost.
      if (priorLayout !== undefined) {
        try {
          this.deps.onRollbackError?.("rollback:priorLayoutSnapshot", priorLayout);
        } catch {
          /* Diagnostic callback threw — swallow, original error still rethrown */
        }
      }
      throw LayoutReflow.toTypedError("removePane:applyGeometry", error);
    }
  }

  /**
   * Reconcile `paneMap` with the live tmux window: any name whose pane id is
   * NOT in `paneIndexOrder(target)` is dropped. Used by `removePane`'s rollback
   * to catch cases where a parallel external `kill-pane` (or a cascade from
   * the failed reflow) left a paneMap entry pointing at a dead pane.
   */
  private async reconcilePaneMap(target: string): Promise<void> {
    const liveOrder = await this.tmux.paneIndexOrder(target);
    const liveIds = new Set(liveOrder.map((entry) => entry.id));
    const paneMap = this.deps.getPaneMap();
    for (const [name, paneId] of Object.entries(paneMap)) {
      if (!liveIds.has(paneId)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- reconciling against live state
        delete paneMap[name];
      }
    }
  }
}

export { LayoutReflow, TmuxFailedError };
export type { ApplyGeometryOptions, LayoutReflowDeps, PaneMap, Rect };
