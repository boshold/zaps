import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
import { isLayoutLeaf, isLayoutSplit } from "#src/config/types.js";

import { splitPane } from "./tmux.js";

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

async function walkLayout(
  node: LayoutNode,
  currentPaneId: string,
  paneMap: PaneMap,
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
    // new pane after its predecessor, preserving the declared order.
    let splitTarget = currentPaneId;
    let parentRemaining = 100;

    for (let i = 1; i < children.length; i += 1) {
      const childRemaining = parentRemaining - sizes[i - 1];
      const tmuxPercent = Math.round((childRemaining / parentRemaining) * 100);

      const newPaneId = await splitPane(splitTarget, dir, tmuxPercent);
      paneIds.push(newPaneId);
      splitTarget = newPaneId;
      parentRemaining = childRemaining;
    }

    // Recurse into each child (must be sequential for tmux ordering)
    let focusPane = "";
    for (let i = 0; i < children.length; i += 1) {
      const result = await walkLayout(children[i], paneIds[i], paneMap);
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

export function validateLayout(layout: LayoutNode, serviceNames: string[]): void {
  const paneNames = collectPaneNames(layout);
  const seen = new Set<string>();

  for (const pane of paneNames) {
    if (pane !== "@tui" && !serviceNames.includes(pane)) {
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
}

/**
 * Create the tmux layout from the config tree.
 * Returns a map of service name -> tmux pane ID.
 */
export async function createLayout(
  startPaneId: string,
  layout: LayoutNode | undefined,
  services: Record<string, ServiceConfig>,
): Promise<{ paneMap: PaneMap; focusPane: string }> {
  const paneMap: PaneMap = {};
  const serviceNames = Object.keys(services);

  if (!layout) {
    // Case 1: No layout — @tui gets start pane, each service gets a split pane
    paneMap["@tui"] = startPaneId;

    for (const name of serviceNames) {
      if (!services[name].detached) {
        const paneId = await splitPane(startPaneId, "v");
        paneMap[name] = paneId;
      }
    }

    return { paneMap, focusPane: paneMap["@tui"] };
  }

  // Case 2: Layout tree provided
  const focusName = await walkLayout(layout, startPaneId, paneMap);

  // Services not in layout get split panes (skip detached)
  for (const name of serviceNames) {
    if (!services[name].detached && !(name in paneMap)) {
      const paneId = await splitPane(startPaneId, "v");
      paneMap[name] = paneId;
    }
  }

  return { paneMap, focusPane: (focusName && paneMap[focusName]) || paneMap["@tui"] };
}
