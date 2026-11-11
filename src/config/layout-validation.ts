import type { LayoutNode } from "./types.js";
import { isLayoutLeaf, isLayoutSplit } from "./types.js";

export function collectPaneNames(node: LayoutNode): string[] {
  if (isLayoutLeaf(node)) {
    return [node.pane];
  }
  if (isLayoutSplit(node)) {
    return node.children.flatMap(collectPaneNames);
  }
  return [];
}

/** Name of the first leaf in DFS order — the leaf that inherits the start pane. */
export function firstLeafName(node: LayoutNode): string | undefined {
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
