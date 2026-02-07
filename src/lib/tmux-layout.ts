// eslint-disable-next-line import/no-relative-parent-imports -- Layout needs config types
import type { LayoutNode, ServiceConfig } from "../config/types.js";

// eslint-disable-next-line import/no-relative-parent-imports -- Layout needs config type guards
import { isLayoutLeaf, isLayoutSplit } from "../config/types.js";

import { listPanes, newWindow, splitPane } from "./tmux.js";

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
): Promise<void> {
  if (isLayoutLeaf(node)) {
    paneMap[node.pane] = currentPaneId;
    return;
  }

  if (isLayoutSplit(node)) {
    const { children, direction } = node;
    const dir = direction === "rows" ? "v" : "h";

    // Parse sizes from children
    const sizes = children.map((child) => {
      if (child.size) {
        return Number.parseInt(child.size, 10);
      }
      return Math.floor(100 / children.length);
    });

    // First child inherits the current pane
    const paneIds: string[] = [currentPaneId];

    // Children 2..N: split from the current pane (must be sequential)
    for (let i = 1; i < children.length; i += 1) {
      const consumed = sizes.slice(0, i).reduce((a, b) => a + b, 0);
      const remaining = 100 - consumed;
      const tmuxPercent = Math.round((sizes[i] / remaining) * 100);

      // eslint-disable-next-line no-await-in-loop -- Splits must be sequential
      const newPaneId = await splitPane(currentPaneId, dir, tmuxPercent);
      paneIds.push(newPaneId);
    }

    // Recurse into each child (must be sequential for tmux ordering)
    for (let i = 0; i < children.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- Recursive layout walk must be sequential
      await walkLayout(children[i], paneIds[i], paneMap);
    }
  }
}

/**
 * Validate a layout tree against available service names.
 * Throws on unknown panes, duplicates, or missing @tui.
 */
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
}

/**
 * Create the tmux layout from the config tree.
 * Returns a map of service name -> tmux pane ID.
 */
export async function createLayout(
  session: string,
  layout: LayoutNode | undefined,
  services: Record<string, ServiceConfig>,
): Promise<PaneMap> {
  const paneMap: PaneMap = {};
  const serviceNames = Object.keys(services);

  // Get the first pane from the session (already created by newSession)
  const panes = await listPanes(session);
  const firstPaneId = panes[0].id;

  if (!layout) {
    // Case 1: No layout — @tui gets first pane, each service gets a background window
    paneMap["@tui"] = firstPaneId;

    for (const name of serviceNames) {
      if (!services[name].detached) {
        // eslint-disable-next-line no-await-in-loop -- Windows must be created sequentially
        const paneId = await newWindow(session);
        paneMap[name] = paneId;
      }
    }

    return paneMap;
  }

  // Case 2: Layout tree provided
  await walkLayout(layout, firstPaneId, paneMap);

  // Services not in layout get background windows (skip detached)
  for (const name of serviceNames) {
    if (!services[name].detached && !(name in paneMap)) {
      // eslint-disable-next-line no-await-in-loop -- Windows must be created sequentially
      const paneId = await newWindow(session);
      paneMap[name] = paneId;
    }
  }

  return paneMap;
}
