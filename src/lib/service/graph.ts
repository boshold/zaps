/**
 * Topological sort and cycle detection for service/task dependency graphs.
 * Uses Kahn's algorithm for level-based ordering and DFS for cycle detection.
 */

function dfs(
  node: string,
  services: Record<string, { dependsOn?: string[] }>,
  visited: Set<string>,
  inStack: Set<string>,
  parent: Map<string, string>,
): string[] | null {
  if (inStack.has(node)) {
    // Reconstruct cycle path
    const cycle: string[] = [node];
    let current = parent.get(node);
    while (typeof current === "string" && current !== node) {
      cycle.push(current);
      current = parent.get(current);
    }
    cycle.push(node);
    return cycle.toReversed();
  }

  if (visited.has(node)) {
    return null;
  }

  visited.add(node);
  inStack.add(node);

  const deps = services[node]?.dependsOn ?? [];
  for (const dep of deps) {
    parent.set(dep, node);
    const cycle = dfs(dep, services, visited, inStack, parent);
    if (cycle) {
      return cycle;
    }
  }

  inStack.delete(node);
  return null;
}

/**
 * DFS-based cycle detection.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycles(services: Record<string, { dependsOn?: string[] }>): string[] | null {
  const names = Object.keys(services);
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  for (const name of names) {
    const cycle = dfs(name, services, visited, inStack, parent);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns levels — services at the same level can start in parallel.
 */
export function topoSort(services: Record<string, { dependsOn?: string[] }>): string[][] {
  const names = Object.keys(services);
  if (names.length === 0) {
    return [];
  }

  // Build adjacency (dependency -> dependents) and in-degree
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const name of names) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const name of names) {
    const deps = services[name].dependsOn ?? [];
    inDegree.set(name, deps.length);
    for (const dep of deps) {
      const depList = dependents.get(dep);
      if (depList) {
        depList.push(name);
      }
    }
  }

  // Initialize queue with nodes that have in-degree 0
  let queue = names.filter((n) => inDegree.get(n) === 0);
  const levels: string[][] = [];
  let processed = 0;

  while (queue.length > 0) {
    levels.push([...queue]);
    processed += queue.length;
    const nextQueue: string[] = [];

    for (const node of queue) {
      const nodeDeps = dependents.get(node) ?? [];
      for (const dependent of nodeDeps) {
        const currentDeg = inDegree.get(dependent) ?? 0;
        const newDeg = currentDeg - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextQueue.push(dependent);
        }
      }
    }

    queue = nextQueue;
  }

  if (processed !== names.length) {
    const cycle = detectCycles(services);
    const cyclePath = cycle ? cycle.join(" -> ") : "unknown";
    throw new Error(`Circular dependency detected: ${cyclePath}`);
  }

  return levels;
}

/**
 * Reverse topological sort. Used for shutdown order.
 */
export function reverseTopoSort(services: Record<string, { dependsOn?: string[] }>): string[][] {
  return topoSort(services)
    .toReversed()
    .map((level) => level.toReversed());
}

/**
 * Build a map from service name to the transitive list of services that
 * should cascade-restart when it restarts. Uses BFS for ordering (closest first).
 */
export function buildRestartWithMap(
  services: Record<string, { dependsOn?: string[]; restartWith?: string[] }>,
): Map<string, string[]> {
  // Build reverse index: trigger → direct dependents that declared restartWith
  const directDependents = new Map<string, string[]>();
  for (const [name, svc] of Object.entries(services)) {
    for (const dep of svc.restartWith ?? []) {
      const list = directDependents.get(dep) ?? [];
      list.push(name);
      directDependents.set(dep, list);
    }
  }

  const result = new Map<string, string[]>();

  for (const trigger of directDependents.keys()) {
    // BFS transitive closure
    const visited = new Set<string>();
    const queue = [...(directDependents.get(trigger) ?? [])];
    const order: string[] = [];

    while (queue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- BFS queue is non-empty
      const current = queue.shift()!;
      if (visited.has(current)) {
        // eslint-disable-next-line no-continue -- skip already-visited
        continue;
      }
      visited.add(current);
      order.push(current);

      // Transitively follow: anything that has restartWith including `current`
      for (const next of directDependents.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    if (order.length > 0) {
      result.set(trigger, order);
    }
  }

  return result;
}
