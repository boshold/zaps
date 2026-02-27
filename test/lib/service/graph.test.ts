import { describe, expect, it } from "vitest";

import {
  buildRestartWithMap,
  detectCycles,
  reverseTopoSort,
  topoSort,
} from "../../../src/lib/service/graph.js";

describe("topoSort", () => {
  it("linear chain: a->b->c", () => {
    const services = {
      c: { dependsOn: ["b"] },
      b: { dependsOn: ["a"] },
      a: {},
    };

    const result = topoSort(services);
    expect(result).toEqual([["a"], ["b"], ["c"]]);
  });

  it("diamond: a->c, b->c", () => {
    const services = {
      a: {},
      b: {},
      c: { dependsOn: ["a", "b"] },
    };

    const result = topoSort(services);
    expect(result).toHaveLength(2);
    // First level has a and b (no deps)
    expect(result[0].toSorted()).toEqual(["a", "b"]);
    // Second level has c
    expect(result[1]).toEqual(["c"]);
  });

  it("no deps: single level with all services", () => {
    const services = {
      a: {},
      b: {},
      c: {},
    };

    const result = topoSort(services);
    expect(result).toHaveLength(1);
    expect(result[0].toSorted()).toEqual(["a", "b", "c"]);
  });

  it("empty input: returns empty array", () => {
    const result = topoSort({});
    expect(result).toEqual([]);
  });

  it("throws on cycles with descriptive message", () => {
    const services = {
      a: { dependsOn: ["b"] },
      b: { dependsOn: ["a"] },
    };

    expect(() => topoSort(services)).toThrow("Circular dependency detected");
  });
});

describe("detectCycles", () => {
  it("a->b->a returns cycle path", () => {
    const services = {
      a: { dependsOn: ["b"] },
      b: { dependsOn: ["a"] },
    };

    const cycle = detectCycles(services);
    expect(cycle).not.toBeNull();
    if (cycle) {
      // Cycle should contain both a and b, and start/end with same node
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("no cycle returns null", () => {
    const services = {
      a: {},
      b: { dependsOn: ["a"] },
      c: { dependsOn: ["b"] },
    };

    expect(detectCycles(services)).toBeNull();
  });

  it("diamond dep: node reachable via two paths returns null (visited early return)", () => {
    const services = {
      a: {},
      b: { dependsOn: ["a"] },
      c: { dependsOn: ["a"] },
      d: { dependsOn: ["b", "c"] },
    };

    expect(detectCycles(services)).toBeNull();
  });

  it("self-dependency a->a returns cycle", () => {
    const services = {
      a: { dependsOn: ["a"] },
    };

    const cycle = detectCycles(services);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(["a", "a"]);
  });
});

describe("reverseTopoSort", () => {
  it("linear chain reversed correctly", () => {
    const services = {
      c: { dependsOn: ["b"] },
      b: { dependsOn: ["a"] },
      a: {},
    };

    const result = reverseTopoSort(services);
    expect(result).toEqual([["c"], ["b"], ["a"]]);
  });
});

describe("buildRestartWithMap", () => {
  it("direct: db restart cascades to api", () => {
    const services = {
      db: {},
      api: { dependsOn: ["db"], restartWith: ["db"] },
    };

    const map = buildRestartWithMap(services);
    expect(map.get("db")).toEqual(["api"]);
  });

  it("transitive: db→api→frontend chain", () => {
    const services = {
      db: {},
      api: { dependsOn: ["db"], restartWith: ["db"] },
      frontend: { dependsOn: ["api"], restartWith: ["api"] },
    };

    const map = buildRestartWithMap(services);
    expect(map.get("db")).toEqual(["api", "frontend"]);
    expect(map.get("api")).toEqual(["frontend"]);
  });

  it("empty: no restartWith → empty map", () => {
    const services = {
      db: {},
      api: { dependsOn: ["db"] },
    };

    const map = buildRestartWithMap(services);
    expect(map.size).toBe(0);
  });

  it("partial: only some deps in restartWith", () => {
    const services = {
      db: {},
      cache: {},
      api: { dependsOn: ["db", "cache"], restartWith: ["db"] },
    };

    const map = buildRestartWithMap(services);
    expect(map.get("db")).toEqual(["api"]);
    expect(map.has("cache")).toBe(false);
  });

  it("diamond: deduplicates nodes reachable via two paths", () => {
    const services = {
      db: {},
      api: { restartWith: ["db"] },
      worker: { restartWith: ["db"] },
      gateway: { restartWith: ["api", "worker"] },
    };

    const map = buildRestartWithMap(services);
    expect(map.get("db")).toEqual(["api", "worker", "gateway"]);
    // gateway only appears once despite being reachable via both api and worker
    expect(map.get("db")?.filter((n) => n === "gateway")).toHaveLength(1);
  });
});
