import type { LayoutLeaf, LayoutNode, LayoutSplit, ServiceConfig } from "#src/config/types.js";
import { isLayoutLeaf, isLayoutSplit } from "#src/config/types.js";

import { killPane, splitPane } from "./tmux.js";

type PaneMap = Record<string, string>;

function collectPaneNames(node: LayoutNode): string[] {
  if (isLayoutLeaf(node)) {
    return [node.pane];
  }
  if (isLayoutSplit(node)) {
    return node.children.flatMap(collectPaneNames);
  }
  return [];
}

/** Name of the first leaf in DFS order — the leaf that inherits the start pane. */
function firstLeafName(node: LayoutNode): string | undefined {
  if (isLayoutLeaf(node)) {
    return node.pane;
  }
  if (isLayoutSplit(node)) {
    for (const child of node.children) {
      const name = firstLeafName(child);
      if (name) {
        return name;
      }
    }
  }
  return undefined;
}

async function walkLayout(
  node: LayoutNode,
  currentPaneId: string,
  paneMap: PaneMap,
  createdPanes: string[],
): Promise<string> {
  if (isLayoutLeaf(node)) {
    paneMap[node.pane] = currentPaneId;
    return node.focus ? node.pane : "";
  }

  if (isLayoutSplit(node)) {
    const { children, direction } = node;
    const dir = direction === "rows" ? "v" : "h";

    // Parse sizes: explicit sizes kept, implicit get equal share of remainder
    const explicitTotal = children.reduce(
      (sum, child) => sum + (child.size ? Number.parseInt(child.size, 10) : 0),
      0,
    );
    const implicitCount = children.filter((child) => !child.size).length;
    const implicitSize = implicitCount > 0 ? Math.floor((100 - explicitTotal) / implicitCount) : 0;

    const sizes = children.map((child) =>
      child.size ? Number.parseInt(child.size, 10) : implicitSize,
    );

    // First child inherits the current pane
    const paneIds: string[] = [currentPaneId];

    // Children 2..N: split from the *previous* pane so tmux inserts each
    // New pane after its predecessor, preserving the declared order.
    let splitTarget = currentPaneId;
    let parentRemaining = 100;

    for (let i = 1; i < children.length; i += 1) {
      const childRemaining = parentRemaining - sizes[i - 1];
      const tmuxPercent = Math.round((childRemaining / parentRemaining) * 100);

      const newPaneId = await splitPane(splitTarget, dir, { percent: tmuxPercent });
      createdPanes.push(newPaneId);
      paneIds.push(newPaneId);
      splitTarget = newPaneId;
      parentRemaining = childRemaining;
    }

    // Recurse into each child (must be sequential for tmux ordering)
    let focusPane = "";
    for (let i = 0; i < children.length; i += 1) {
      const result = await walkLayout(children[i], paneIds[i], paneMap, createdPanes);
      if (result) {
        focusPane = result;
      }
    }
    return focusPane;
  }

  return "";
}

/**
 * Validate a layout tree against available service names.
 * Throws on unknown panes, duplicates, or missing @tui.
 */
function collectFocusedPanes(node: LayoutNode): string[] {
  if (isLayoutLeaf(node)) {
    return node.focus ? [node.pane] : [];
  }
  if (isLayoutSplit(node)) {
    return node.children.flatMap(collectFocusedPanes);
  }
  return [];
}

/**
 * After layout walk, expand group pane mappings so each child service
 * in an expanded docker group shares the same tmux pane as the group.
 */
function expandGroupPanes(paneMap: PaneMap, groups: Map<string, string[]>): void {
  for (const [groupName, children] of groups) {
    const groupPaneId = paneMap[groupName];
    if (groupPaneId) {
      for (const child of children) {
        paneMap[child] = groupPaneId;
      }
    }
  }
}

/** Split a vertical pane off `startPaneId`, recording it for rollback. */
async function splitTracked(startPaneId: string, createdPanes: string[]): Promise<string> {
  const paneId = await splitPane(startPaneId, "v");
  createdPanes.push(paneId);
  return paneId;
}

/** Every group member name across all groups (members never get an own pane). */
function collectGroupChildNames(groups?: Map<string, string[]>): Set<string> {
  const names = new Set<string>();
  if (groups) {
    for (const children of groups.values()) {
      for (const child of children) {
        names.add(child);
      }
    }
  }
  return names;
}

/** Give each not-yet-mapped group one shared pane and map all its members (E10). */
async function mapUnreferencedGroups(
  startPaneId: string,
  groups: Map<string, string[]>,
  paneMap: PaneMap,
  createdPanes: string[],
): Promise<void> {
  for (const [groupName, children] of groups) {
    if (groupName in paneMap) {
      continue;
    }
    const paneId = await splitTracked(startPaneId, createdPanes);
    paneMap[groupName] = paneId;
    for (const child of children) {
      paneMap[child] = paneId;
    }
  }
}

/** Split a pane for each non-detached, non-group, unmapped service. */
async function mapLeftoverServices(
  startPaneId: string,
  serviceNames: string[],
  services: Record<string, ServiceConfig>,
  groupChildNames: Set<string>,
  paneMap: PaneMap,
  createdPanes: string[],
): Promise<void> {
  for (const name of serviceNames) {
    if (!services[name].detached && !groupChildNames.has(name) && !(name in paneMap)) {
      paneMap[name] = await splitTracked(startPaneId, createdPanes);
    }
  }
}

/**
 * Reserve the start pane for `@tui` (reload): if a non-`@tui` first leaf claimed
 * it, swap so `@tui` keeps the start pane and the service takes the split pane.
 */
function reserveStartPaneForTui(layout: LayoutNode, startPaneId: string, paneMap: PaneMap): void {
  const first = firstLeafName(layout);
  const tuiSlotPane = paneMap["@tui"];
  if (first && first !== "@tui" && tuiSlotPane !== undefined && tuiSlotPane !== startPaneId) {
    paneMap["@tui"] = startPaneId;
    paneMap[first] = tuiSlotPane;
  }
}

/**
 * Shallow-clone `node`, replacing its `size` with `size` (omitted when undefined).
 * Used when collapsing a single-child split: the lone survivor takes over the
 * split's slot, so it must inherit the split's size — its own size was relative
 * to the now-gone split and is no longer meaningful.
 */
function withSize(node: LayoutNode, size: string | undefined): LayoutNode {
  if (isLayoutLeaf(node)) {
    const leaf: LayoutLeaf = { pane: node.pane };
    if (size !== undefined) {
      leaf.size = size;
    }
    if (node.focus !== undefined) {
      leaf.focus = node.focus;
    }
    return leaf;
  }
  const split: LayoutSplit = { direction: node.direction, children: node.children };
  if (size !== undefined) {
    split.size = size;
  }
  return split;
}

/** Absolute tmux cell rectangle of a single pane (declared here, exported below). */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Thrown by `computeRects` when a pane's computed extent drops below 1 cell, so
 * an invalid geometry is never serialized into a `select-layout` string. Carries
 * the offending pane name and a stable `code` for callers to branch on.
 */
class PaneTooSmallError extends Error {
  public readonly code = "PANE_TOO_SMALL" as const;
  public readonly pane: string;

  public constructor(pane: string, dimension: "width" | "height", value: number) {
    super(`Layout pane '${pane}' computes ${dimension} ${value}; minimum is 1 cell`);
    this.name = "PaneTooSmallError";
    this.pane = pane;
  }
}

/**
 * Per-child proportional weight, reusing the createLayout/validateLayoutSizes
 * size math: explicit-size children weigh their percent, implicit children each
 * weigh an equal share of the remainder. The weights are normalized against
 * their own sum in `distributeExtents`, which rescales surviving proportions to
 * fill the available extent (so a filtered split whose survivors no longer sum
 * to 100 still fills the parent without a gap).
 */
function childWeights(children: LayoutNode[]): number[] {
  const explicitTotal = children.reduce(
    (sum, child) => sum + (child.size ? Number.parseInt(child.size, 10) : 0),
    0,
  );
  const implicitCount = children.filter((child) => !child.size).length;
  const implicitSize = implicitCount > 0 ? Math.floor((100 - explicitTotal) / implicitCount) : 0;
  return children.map((child) => (child.size ? Number.parseInt(child.size, 10) : implicitSize));
}

/**
 * Split `parentExtent` cells among `children` along one axis, charging a 1-cell
 * divider per boundary. The children share `content = parentExtent − (n − 1)`
 * cells, distributed by cumulative-boundary rounding of their normalized
 * weights: boundary_i = round(content · Σweights≤i / Σweights), each child's
 * extent is the gap between successive boundaries. This matches tmux's own
 * division (an 80-col 2-way split yields 40|39, the first child taking the
 * rounded-up half), guarantees `Σextents === content` exactly (the last child
 * absorbs the residual), and rescales survivors to fill after a filter drop.
 */
/**
 * Cumulative boundary cell after child `i` (1-based count `i + 1`). The last
 * child's boundary is pinned to `content` so the extents always sum exactly;
 * earlier boundaries round the normalized cumulative weight, with an even-split
 * fallback for the degenerate all-zero-weight case.
 */
function cumulativeBoundary(
  i: number,
  n: number,
  content: number,
  cumulativeWeight: number,
  totalWeight: number,
): number {
  if (i === n - 1) {
    return content;
  }
  if (totalWeight > 0) {
    return Math.round((content * cumulativeWeight) / totalWeight);
  }
  return Math.round((content * (i + 1)) / n);
}

function distributeExtents(children: LayoutNode[], parentExtent: number): number[] {
  const n = children.length;
  const weights = childWeights(children);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const content = parentExtent - (n - 1);

  const extents: number[] = [];
  let previousBoundary = 0;
  let cumulativeWeight = 0;
  for (let i = 0; i < n; i += 1) {
    cumulativeWeight += weights[i];
    const boundary = cumulativeBoundary(i, n, content, cumulativeWeight, totalWeight);
    extents.push(boundary - previousBoundary);
    previousBoundary = boundary;
  }
  return extents;
}

/**
 * Recursively place `node` into the absolute rectangle (`x`, `y`, `width`,
 * `height`), writing each leaf's `Rect` into `out`. Columns splits divide width
 * (children share full height), rows splits divide height; each child after the
 * first starts one divider cell past its predecessor. Throws `PaneTooSmallError`
 * the moment any extent drops below 1 cell.
 */
function fillRects(
  node: LayoutNode,
  x: number,
  y: number,
  width: number,
  height: number,
  out: Map<string, Rect>,
): void {
  if (isLayoutLeaf(node)) {
    if (width < 1) {
      throw new PaneTooSmallError(node.pane, "width", width);
    }
    if (height < 1) {
      throw new PaneTooSmallError(node.pane, "height", height);
    }
    out.set(node.pane, { x, y, width, height });
    return;
  }

  if (isLayoutSplit(node)) {
    const { children, direction } = node;
    const isColumns = direction === "columns";
    const axisExtent = isColumns ? width : height;
    const extents = distributeExtents(children, axisExtent);

    let offset = isColumns ? x : y;
    for (let i = 0; i < children.length; i += 1) {
      const extent = extents[i];
      if (extent < 1) {
        throw new PaneTooSmallError(
          firstLeafName(children[i]) ?? "?",
          isColumns ? "width" : "height",
          extent,
        );
      }
      if (isColumns) {
        fillRects(children[i], offset, y, extent, height, out);
      } else {
        fillRects(children[i], x, offset, width, extent, out);
      }
      offset += extent + 1; // +1 cell for the divider after this child
    }
  }
}

/**
 * Bounding rectangle of a set of child rects. For a layout split the children
 * plus their dividers fill the parent exactly, so the union equals the split's
 * own rect — which is what the tmux layout grammar prints before its `{}`/`[]`.
 */
function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Recursively serialize a node to its tmux layout body and bounding rect. A leaf
 * prints `WxH,X,Y,<paneNumber>`; a split prints its own `WxH,X,Y` followed by its
 * children wrapped in `{...}` (columns) or `[...]` (rows), comma-separated in DFS
 * order. Throws if a leaf has no computed rect or no pane number.
 */
function serializeNode(
  node: LayoutNode,
  rects: Map<string, Rect>,
  paneNumbers: Map<string, number>,
): { rect: Rect; body: string } {
  if (isLayoutLeaf(node)) {
    const rect = rects.get(node.pane);
    if (!rect) {
      throw new Error(`layoutString: no rect computed for pane '${node.pane}'`);
    }
    const paneNumber = paneNumbers.get(node.pane);
    if (paneNumber === undefined) {
      throw new Error(`layoutString: no pane number for pane '${node.pane}'`);
    }
    return { rect, body: `${rect.width}x${rect.height},${rect.x},${rect.y},${paneNumber}` };
  }

  const childResults = node.children.map((child) => serializeNode(child, rects, paneNumbers));
  const rect = unionRect(childResults.map((result) => result.rect));
  const open = node.direction === "columns" ? "{" : "[";
  const close = node.direction === "columns" ? "}" : "]";
  const inner = childResults.map((result) => result.body).join(",");
  return { rect, body: `${rect.width}x${rect.height},${rect.x},${rect.y}${open}${inner}${close}` };
}

/**
 * Validate split sizes before any tmux call (E15). Per split: explicit sizes
 * must sum to < 100, or ≤ 100 only when the split has no implicit-size siblings;
 * and every computed tmux split percent must be ≥ 1. Violations are config
 * errors naming the offending split/pane, never raw tmux errors mid-create.
 */
export function validateLayoutSizes(node: LayoutNode): void {
  if (!isLayoutSplit(node)) {
    return;
  }

  const { children } = node;
  const label = collectPaneNames(node).join(", ");
  const explicitTotal = children.reduce(
    (sum, child) => sum + (child.size ? Number.parseInt(child.size, 10) : 0),
    0,
  );
  const implicitCount = children.filter((child) => !child.size).length;

  if (implicitCount > 0 && explicitTotal >= 100) {
    throw new Error(
      `Layout split [${label}] explicit sizes sum to ${explicitTotal} but the split has implicit-size panes; they must sum to less than 100`,
    );
  }
  if (implicitCount === 0 && explicitTotal > 100) {
    throw new Error(
      `Layout split [${label}] explicit sizes sum to ${explicitTotal}; they must not exceed 100`,
    );
  }

  // Replicate the createLayout split math and require every computed percent ≥ 1.
  const implicitSize = implicitCount > 0 ? Math.floor((100 - explicitTotal) / implicitCount) : 0;
  const sizes = children.map((child) =>
    child.size ? Number.parseInt(child.size, 10) : implicitSize,
  );
  let parentRemaining = 100;
  for (let i = 1; i < children.length; i += 1) {
    const childRemaining = parentRemaining - sizes[i - 1];
    const tmuxPercent = Math.round((childRemaining / parentRemaining) * 100);
    if (tmuxPercent < 1) {
      throw new Error(
        `Layout split [${label}] computes a size below 1% for pane '${firstLeafName(children[i]) ?? "?"}'`,
      );
    }
    parentRemaining = childRemaining;
  }

  for (const child of children) {
    validateLayoutSizes(child);
  }
}

export function validateLayout(
  layout: LayoutNode,
  serviceNames: string[],
  groups?: Map<string, string[]>,
): void {
  const paneNames = collectPaneNames(layout);
  const seen = new Set<string>();

  for (const pane of paneNames) {
    if (pane !== "@tui" && !serviceNames.includes(pane) && !groups?.has(pane)) {
      throw new Error(`Layout references unknown pane '${pane}'`);
    }
    if (seen.has(pane)) {
      throw new Error(`Duplicate pane '${pane}' in layout`);
    }
    seen.add(pane);
  }

  if (!seen.has("@tui")) {
    throw new Error("Layout must include '@tui' pane");
  }

  const focused = collectFocusedPanes(layout);
  if (focused.length > 1) {
    throw new Error(`Only one pane can have focus, found: ${focused.join(", ")}`);
  }

  validateLayoutSizes(layout);
}

/**
 * Create the tmux layout from the config tree.
 * Returns a map of service name -> tmux pane ID.
 *
 * `reserveTuiPane` (reload) guarantees the start pane stays `@tui`: if the
 * layout's first leaf is a service, that service is moved to a freshly split
 * pane and `@tui` keeps the start pane the TUI is running in (A2). On any
 * `splitPane` failure mid-build, every pane created by this call is killed
 * (best-effort) before the error is rethrown, so no half-built layout leaks
 * (E15).
 */
export async function createLayout(
  startPaneId: string,
  layout: LayoutNode | undefined,
  services: Record<string, ServiceConfig>,
  groups?: Map<string, string[]>,
  options?: { reserveTuiPane?: boolean; skip?: Set<string> },
): Promise<{ paneMap: PaneMap; focusPane: string }> {
  const reserveTuiPane = options?.reserveTuiPane ?? false;
  const skip = options?.skip;
  const hasSkip = skip !== undefined && skip.size > 0;
  const paneMap: PaneMap = {};
  // Pane-less lazy services don't get a leftover-pane split. `skip` is pre-
  // Resolved by the loader (P04-T02 lazyPaneByService) AND the autostart guard
  // (`flags?.start === false`). Group members + detached are guaranteed absent
  // From `skip` by P04-T02's guard-first rule, so no group-pane desync here.
  const serviceNames = hasSkip
    ? Object.keys(services).filter((n) => !skip.has(n))
    : Object.keys(services);
  const groupChildNames = collectGroupChildNames(groups);
  const createdPanes: string[] = [];

  try {
    if (!layout) {
      // Case 1: No layout — @tui gets the start pane, each service/group a split.
      paneMap["@tui"] = startPaneId;
      if (groups) {
        await mapUnreferencedGroups(startPaneId, groups, paneMap, createdPanes);
      }
      await mapLeftoverServices(
        startPaneId,
        serviceNames,
        services,
        groupChildNames,
        paneMap,
        createdPanes,
      );
      return { paneMap, focusPane: paneMap["@tui"] };
    }

    // Case 2: Layout tree provided. When a skip set is in play, filter the tree
    // To the boot-visible leaf set BEFORE walking. The SAME filtered tree must
    // Feed both `walkLayout` and `reserveStartPaneForTui` — otherwise
    // FirstLeafName on the raw layout could disagree with the leaf walkLayout
    // Actually mapped, mislabeling `@tui` on the reload path (Round-5 sharp edge).
    let bootLayout: LayoutNode | undefined = layout;
    if (hasSkip) {
      const visible = new Set<string>();
      for (const name of collectPaneNames(layout)) {
        if (!skip.has(name)) {
          visible.add(name);
        }
      }
      // eslint-disable-next-line no-use-before-define -- `filterTree` is a top-level function declaration (hoisted); keeping it next to other exports
      bootLayout = filterTree(layout, visible);
    }
    if (!bootLayout) {
      throw new Error(
        "createLayout: every layout leaf is skipped (the @tui slot must always be visible)",
      );
    }

    const focusName = await walkLayout(bootLayout, startPaneId, paneMap, createdPanes);

    if (reserveTuiPane) {
      reserveStartPaneForTui(bootLayout, startPaneId, paneMap);
    }

    if (groups) {
      // Referenced groups: map members to the group's pane; unreferenced: one
      // Shared pane each (E10).
      expandGroupPanes(paneMap, groups);
      await mapUnreferencedGroups(startPaneId, groups, paneMap, createdPanes);
    }

    await mapLeftoverServices(
      startPaneId,
      serviceNames,
      services,
      groupChildNames,
      paneMap,
      createdPanes,
    );

    return { paneMap, focusPane: (focusName && paneMap[focusName]) || paneMap["@tui"] };
  } catch (error) {
    // Best-effort: tear down every pane this call created so a failed
    // Create/reload never leaves a half-built layout behind (E15).
    for (const paneId of createdPanes) {
      await killPane(paneId).catch(() => {
        /* Swallow — cleanup is best-effort */
      });
    }
    throw error;
  }
}

/**
 * Filter a declared layout tree down to the currently-visible panes.
 *
 * Returns a NEW tree (no input mutation) where:
 * - leaves whose `pane` is not in `visible` are dropped;
 * - a split that ends up with one child is collapsed into that child
 *   (recursively), with the child inheriting the split's slot size;
 * - a split that ends up with zero visible children returns `undefined`.
 *
 * Surviving siblings keep their declared sizes: explicit-size survivors keep
 * their percent and implicit survivors share the remainder. Because removal can
 * only lower a split's explicit total, the result never has explicit sizes ≥ 100
 * alongside implicit siblings — so it is always valid input to `computeRects`,
 * which normalizes the surviving proportions against the available extent
 * (e.g. dropping one of two all-explicit survivors leaves the geometry pass to
 * rescale them). Redistribution math is intentionally NOT duplicated here.
 */
export function filterTree(
  node: LayoutNode | undefined,
  visible: Set<string>,
): LayoutNode | undefined {
  if (!node) {
    return undefined;
  }

  if (isLayoutLeaf(node)) {
    return visible.has(node.pane) ? { ...node } : undefined;
  }

  if (isLayoutSplit(node)) {
    const children = node.children
      .map((child) => filterTree(child, visible))
      .filter((child): child is LayoutNode => child !== undefined);

    if (children.length === 0) {
      return undefined;
    }
    if (children.length === 1) {
      // Collapse: the lone survivor takes over this split's slot.
      return withSize(children[0], node.size);
    }

    const split: LayoutSplit = { direction: node.direction, children };
    if (node.size !== undefined) {
      split.size = node.size;
    }
    return split;
  }

  return undefined;
}

export type { Rect };
export { PaneTooSmallError };

/**
 * Convert a (filtered) proportional layout tree into absolute tmux cell
 * rectangles per pane name, exactly honoring tmux's geometry rules so the result
 * can be serialized into a `select-layout` string tmux accepts without
 * normalization. `width`/`height` are the tmux window dimensions.
 *
 * Each split charges a 1-cell divider per boundary (`Σ child extents + (n − 1)
 * === parent extent` on the split axis; cross-axis matches the parent), the last
 * child absorbs the integer-division residual, and surviving proportions are
 * rescaled to fill the extent. Throws `PaneTooSmallError` (naming the pane) if
 * any pane would be smaller than 1 cell.
 */
export function computeRects(tree: LayoutNode, width: number, height: number): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  fillRects(tree, 0, 0, width, height, rects);
  return rects;
}

/**
 * Tmux's layout checksum over the layout body (verified character-identical to
 * tmux `layout-custom.c` against a live `#{window_layout}` string). Returns a
 * lowercase, zero-padded 4-hex-digit string. `select-layout` rejects a layout
 * string whose checksum prefix does not equal this for the body.
 */
export function checksum(body: string): string {
  // 65_535 === 0xFFFF — a 16-bit mask (decimal avoids the oxfmt/oxlint hex-case conflict).
  /* eslint-disable no-bitwise -- tmux's checksum is defined in terms of bit ops; must match byte-for-byte */
  let c = 0;
  for (const ch of body) {
    c = ((c >> 1) + ((c & 1) << 15)) & 65_535;
    c = (c + ch.charCodeAt(0)) & 65_535;
  }
  return c.toString(16).padStart(4, "0");
  /* eslint-enable no-bitwise */
}

/**
 * Serialize a layout tree + computed rects + pane numbers into the exact
 * `<checksum>,<body>` string tmux's `select-layout` accepts. The body encodes the
 * cell tree in tmux grammar — leaves as `WxH,X,Y,<paneNumber>`, columns splits
 * wrapped in `{...}`, rows splits in `[...]`, DFS order; a single-pane tree emits
 * a bare leaf cell with no braces. `rects` must come from `computeRects` for the
 * same tree so the divider geometry matches tmux byte-for-byte.
 */
export function layoutString(
  tree: LayoutNode,
  rects: Map<string, Rect>,
  paneNumbers: Map<string, number>,
): string {
  const { body } = serializeNode(tree, rects, paneNumbers);
  return `${checksum(body)},${body}`;
}

/**
 * Resolve the swap pairs that turn `current` spatial pane order into `target` DFS
 * order via selection sort: for each slot `i`, if `current[i]` is wrong, swap in
 * the pane that belongs there and emit the pair `[current[i], target[i]]`. Each
 * pair maps 1:1 to a `swap-pane -s <from> -t <to>` call (positions swap, both
 * processes stay attached). Returns `[]` when already in order.
 *
 * This is the reorder *fallback* — the primary insert path is a zero-swap
 * adjacency split. `current` and `target` must be permutations of the same
 * multiset of pane ids; a mismatch is a programmer error and throws.
 */
export function resolvePermutation(current: string[], target: string[]): [string, string][] {
  const sortedCurrent = [...current].toSorted();
  const sortedTarget = [...target].toSorted();
  if (
    sortedCurrent.length !== sortedTarget.length ||
    sortedCurrent.some((value, i) => value !== sortedTarget[i])
  ) {
    throw new Error(
      `resolvePermutation: current [${current.join(", ")}] and target [${target.join(", ")}] are not permutations of the same set`,
    );
  }

  const work = [...current];
  const swaps: [string, string][] = [];
  for (let i = 0; i < work.length; i += 1) {
    if (work[i] === target[i]) {
      continue;
    }
    // The pane that belongs at slot i currently sits later in `work`.
    const j = work.indexOf(target[i], i + 1);
    swaps.push([work[i], target[i]]);
    [work[i], work[j]] = [work[j], work[i]];
  }
  return swaps;
}

/**
 * Where to split so a newly-inserted pane lands at its target spatial slot with
 * zero swaps. `tree` is the TARGET filtered tree (the visible set *including* the
 * pane being inserted); `name` is the inserted pane. Using the tree's DFS leaf
 * order: a pane at slot `k > 0` splits *after* the leaf at `k − 1`
 * (`split-window` default), and a pane at slot `0` splits *before* the next leaf
 * (`split-window -b`). tmux gives the new pane the adjacent `pane_index`, so the
 * spatial order already matches the target and no `swap-pane` is needed.
 *
 * Throws if `name` is not a leaf in `tree`, or if it is the only leaf (no
 * neighbor to anchor against — `@tui` is always visible, so this should not
 * happen in practice).
 */
export function splitAnchor(
  tree: LayoutNode,
  name: string,
): { mode: "after"; predecessor: string } | { mode: "before"; successor: string } {
  const leaves = collectPaneNames(tree);
  const k = leaves.indexOf(name);
  if (k === -1) {
    throw new Error(`splitAnchor: pane '${name}' is not a leaf in the target tree`);
  }
  if (leaves.length < 2) {
    throw new Error(`splitAnchor: pane '${name}' is the only leaf; no neighbor to anchor against`);
  }
  if (k > 0) {
    return { mode: "after", predecessor: leaves[k - 1] };
  }
  return { mode: "before", successor: leaves[1] };
}
