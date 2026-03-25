import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutNode, ProjectConfig, ServiceConfig } from "../../src/config/types.js";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

const { resolveOptionalServices, stripUnavailableServices, collapseLayoutTree } =
  await import("../../src/config/loader.js");

function fakeProc(event: "close" | "error", value: unknown) {
  return {
    // eslint-disable-next-line eslint-plugin-promise/prefer-await-to-callbacks -- mock process event emitter
    on(ev: string, handler: (...args: unknown[]) => void) {
      if (ev === event) {
        queueMicrotask(() => handler(value));
      }
      return this;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// === resolveOptionalServices ===

describe("resolveOptionalServices", () => {
  it("returns empty map when no services have optional", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "node server.js" },
      web: { start: "npm run dev" },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
  });

  it("marks service as available when binary found (exit code 0)", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      db: { start: "rainfrog -u pg", optional: true },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v rainfrog"]);
  });

  it("marks service as unavailable when binary not found (exit code 1)", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 1));
    const services: Record<string, ServiceConfig> = {
      db: { start: "rainfrog -u pg", optional: true },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(1);
    expect(result.get("db")).toEqual({ name: "db", reason: "binary 'rainfrog' not found" });
  });

  it("extracts binary from first word of start command", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      tool: { start: "mytool --flag --verbose", optional: true },
    };
    await resolveOptionalServices(services);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v mytool"]);
  });

  it("extracts binary from run command when start is absent", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      tool: { run: "checker --once", optional: true },
    };
    await resolveOptionalServices(services);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v checker"]);
  });

  it("marks service as available when predicate returns true", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "pg", optional: async () => true },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
  });

  it("marks service as unavailable when predicate returns false", async () => {
    const services: Record<string, ServiceConfig> = {
      db: { start: "pg", optional: async () => false },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(1);
    expect(result.get("db")).toEqual({
      name: "db",
      reason: "availability check returned false",
    });
  });

  it("marks service as unavailable when predicate throws", async () => {
    const services: Record<string, ServiceConfig> = {
      db: {
        start: "pg",
        optional: async () => {
          throw new Error("check failed");
        },
      },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(1);
    expect(result.get("db")?.reason).toBe("availability check returned false");
  });

  it("marks service as unavailable when predicate times out", async () => {
    vi.useFakeTimers();
    const services: Record<string, ServiceConfig> = {
      db: {
        start: "pg",
        // eslint-disable-next-line no-empty-function -- intentionally never resolves
        optional:  async () => new Promise<boolean>(() => {}),
      },
    };
    const promise = resolveOptionalServices(services);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;
    expect(result.size).toBe(1);
    expect(result.get("db")?.reason).toBe("availability check returned false");
    vi.useRealTimers();
  });

  it("skips services with optional: false", async () => {
    const services: Record<string, ServiceConfig> = {
      api: { start: "node server.js", optional: false },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("resolves multiple optional services in parallel", async () => {
    mockSpawn.mockImplementation(() => fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      a: { start: "bin-a", optional: true },
      b: { start: "bin-b", optional: true },
      c: { start: "bin-c", optional: true },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it("handles mix of binary and predicate checks", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 1));
    const services: Record<string, ServiceConfig> = {
      tool: { start: "missingtool", optional: true },
      checker: { start: "node check.js", optional: async () => true },
      normal: { start: "node app.js" },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(1);
    expect(result.has("tool")).toBe(true);
    expect(result.has("checker")).toBe(false);
    expect(result.has("normal")).toBe(false);
  });
});

// === stripUnavailableServices ===

describe("stripUnavailableServices", () => {
  it("removes unavailable services from services record", () => {
    const project: ProjectConfig = {
      services: {
        api: { start: "node api.js" },
        db: { start: "rainfrog", optional: true },
        web: { start: "npm dev" },
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    expect(Object.keys(project.services)).toEqual(["api", "web"]);
  });

  it("filters dependsOn references to unavailable services", () => {
    const project: ProjectConfig = {
      services: {
        api: { start: "node api.js", dependsOn: ["db", "cache"] },
        db: { start: "rainfrog", optional: true },
        cache: { start: "redis-server" },
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    expect(project.services.api.dependsOn).toEqual(["cache"]);
  });

  it("filters restartWith atomically with dependsOn", () => {
    const project: ProjectConfig = {
      services: {
        api: {
          start: "node api.js",
          dependsOn: ["db", "cache"],
          restartWith: ["db"],
        },
        db: { start: "rainfrog", optional: true },
        cache: { start: "redis-server" },
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    expect(project.services.api.dependsOn).toEqual(["cache"]);
    expect(project.services.api.restartWith).toEqual([]);
  });

  it("leaves available services untouched", () => {
    const project: ProjectConfig = {
      services: {
        api: { start: "node api.js", dependsOn: ["cache"] },
        db: { start: "rainfrog", optional: true },
        cache: { start: "redis-server" },
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    expect(project.services.api.dependsOn).toEqual(["cache"]);
    expect(project.services.cache).toBeDefined();
  });

  it("handles empty dependsOn/restartWith after filtering", () => {
    const project: ProjectConfig = {
      services: {
        api: {
          start: "node api.js",
          dependsOn: ["db"],
          restartWith: ["db"],
        },
        db: { start: "rainfrog", optional: true },
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    expect(project.services.api.dependsOn).toEqual([]);
    expect(project.services.api.restartWith).toEqual([]);
  });

  it("collapses layout when unavailable services are removed", () => {
    const project: ProjectConfig = {
      services: {
        api: { start: "node api.js" },
        db: { start: "rainfrog", optional: true },
      },
      layout: {
        direction: "columns" as const,
        children: [{ pane: "api" }, { pane: "db" }],
      },
    };
    stripUnavailableServices(project, new Set(["db"]));
    // Single child collapse: split unwrapped to single leaf
    expect(project.layout).toEqual({ pane: "api" });
  });

  it("removes layout entirely when all services are unavailable", () => {
    const project: ProjectConfig = {
      services: {
        db: { start: "rainfrog", optional: true },
        tool: { start: "mytool", optional: true },
      },
      layout: {
        direction: "columns" as const,
        children: [{ pane: "db" }, { pane: "tool" }],
      },
    };
    stripUnavailableServices(project, new Set(["db", "tool"]));
    expect(project.layout).toBeUndefined();
  });
});

// === collapseLayoutTree ===

describe("collapseLayoutTree", () => {
  it("returns null for a leaf with removed pane", () => {
    const result = collapseLayoutTree({ pane: "db" }, new Set(["db"]));
    expect(result).toBeNull();
  });

  it("returns leaf unchanged for kept pane", () => {
    const leaf: LayoutNode = { pane: "api", size: "50%" };
    const result = collapseLayoutTree(leaf, new Set(["db"]));
    expect(result).toEqual({ pane: "api", size: "50%" });
  });

  it("unwraps single remaining child from split", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "api" }, { pane: "db" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({ pane: "api" });
  });

  it("returns null when all children are removed", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "db" }, { pane: "tool" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db", "tool"]));
    expect(result).toBeNull();
  });

  it("preserves split with multiple remaining children", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "api" }, { pane: "db" }, { pane: "web" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({
      direction: "columns",
      children: [{ pane: "api" }, { pane: "web" }],
    });
  });

  it("collapses nested splits", () => {
    const tree: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui" },
        {
          direction: "columns",
          children: [{ pane: "api" }, { pane: "db" }],
        },
      ],
    };
    // Remove db: inner split collapses to just api, outer becomes rows with @tui + api
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    });
  });

  it("preserves @tui pane (never in removed set)", () => {
    const tree: LayoutNode = {
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "db" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({ pane: "@tui" });
  });

  it("handles deeply nested collapse", () => {
    const tree: LayoutNode = {
      direction: "rows",
      children: [
        { pane: "@tui" },
        {
          direction: "columns",
          children: [
            {
              direction: "rows",
              children: [{ pane: "db" }, { pane: "tool" }],
            },
            { pane: "api" },
          ],
        },
      ],
    };
    // Remove both db and tool: inner rows collapses to null, columns unwraps to api
    const result = collapseLayoutTree(tree, new Set(["db", "tool"]));
    expect(result).toEqual({
      direction: "rows",
      children: [{ pane: "@tui" }, { pane: "api" }],
    });
  });
});
