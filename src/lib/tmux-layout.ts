import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
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

      const newPaneId = await splitPane(splitTarget, dir, tmuxPercent);
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
  options?: { reserveTuiPane?: boolean },
): Promise<{ paneMap: PaneMap; focusPane: string }> {
  const reserveTuiPane = options?.reserveTuiPane ?? false;
  const paneMap: PaneMap = {};
  const serviceNames = Object.keys(services);
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

    // Case 2: Layout tree provided.
    const focusName = await walkLayout(layout, startPaneId, paneMap, createdPanes);

    if (reserveTuiPane) {
      reserveStartPaneForTui(layout, startPaneId, paneMap);
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
