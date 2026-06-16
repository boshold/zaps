import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutNode, ProjectConfig, ServiceConfig } from "../../src/config/types.js";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

const { resolveOptionalServices, stripUnavailableServices, collapseLayoutTree, loadConfig } =
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
        optional: async () => new Promise<boolean>(() => {}),
      },
    };
    const promise = resolveOptionalServices(services);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;
    expect(result.size).toBe(1);
    expect(result.get("db")?.reason).toBe("availability check returned false");
    vi.useRealTimers();
  });

  it("clears the timeout timer when a fast probe settles first (no leak)", async () => {
    vi.useFakeTimers();
    const services: Record<string, ServiceConfig> = {
      db: { start: "pg", optional: async () => true },
    };
    const result = await resolveOptionalServices(services);
    expect(result.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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

// === extractBinary env-prefix handling (G2) ===

describe("extractBinary (via resolveOptionalServices) — env prefixes (G2)", () => {
  it("skips a single NAME=value prefix and probes the real binary", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      stripe: { start: "STRIPE_KEY=x stripe listen", optional: true },
    };
    await resolveOptionalServices(services);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v stripe"]);
  });

  it("skips multiple leading NAME=value assignments", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      svc: { start: "FOO=1 BAR=2 ngrok http 3000", optional: true },
    };
    await resolveOptionalServices(services);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v ngrok"]);
  });

  it("probes the first token for a plain command with no prefix", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const services: Record<string, ServiceConfig> = {
      db: { start: "rainfrog -u pg", optional: true },
    };
    await resolveOptionalServices(services);
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v rainfrog"]);
  });

  it("treats an assignments-only command as unavailable without crashing", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 1));
    const services: Record<string, ServiceConfig> = {
      onlyenv: { start: "FOO=1 BAR=2", optional: true },
    };
    const result = await resolveOptionalServices(services);
    // Empty binary -> `command -v ` -> non-zero exit -> reported unavailable.
    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "command -v "]);
    expect(result.get("onlyenv")?.reason).toBe("binary '' not found");
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

  it("preserves the collapsed split's size on the promoted single child (G4)", () => {
    const tree: LayoutNode = {
      direction: "columns",
      size: "70%",
      children: [{ pane: "api", size: "50%" }, { pane: "db" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    // The promoted child carries the split's outer size, not its sibling-relative one.
    expect(result).toEqual({ pane: "api", size: "70%" });
  });

  it("keeps the child's own size when the collapsed split has no size (G4)", () => {
    const tree: LayoutNode = {
      direction: "columns",
      children: [{ pane: "api", size: "50%" }, { pane: "db" }],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({ pane: "api", size: "50%" });
  });

  it("carries the split size onto a promoted nested split (G4)", () => {
    const tree: LayoutNode = {
      direction: "rows",
      size: "80%",
      children: [
        { pane: "db" },
        { direction: "columns", children: [{ pane: "api" }, { pane: "web" }] },
      ],
    };
    const result = collapseLayoutTree(tree, new Set(["db"]));
    expect(result).toEqual({
      direction: "columns",
      size: "80%",
      children: [{ pane: "api" }, { pane: "web" }],
    });
  });
});

// === stripUnavailableServices with expanded docker groups (G3) ===

describe("stripUnavailableServices — expanded group bookkeeping (G3)", () => {
  function makeExpandedProject(): {
    project: ProjectConfig;
    groups: Map<string, string[]>;
  } {
    const project: ProjectConfig = {
      services: {
        postgres: {
          docker: { service: "postgres" },
          _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: true },
        },
        redis: {
          docker: { service: "redis" },
          dependsOn: ["postgres"],
          _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: false },
        },
        api: { start: "node api.js", dependsOn: ["postgres", "redis"] },
      },
      layout: {
        direction: "columns" as const,
        children: [{ pane: "infra" }, { pane: "api" }],
      },
    };
    return { project, groups: new Map([["infra", ["postgres", "redis"]]]) };
  }

  it("removes a stripped non-owner child and trims the group + siblings' allServices", () => {
    const { project, groups } = makeExpandedProject();
    stripUnavailableServices(project, new Set(["redis"]), groups);

    expect(project.services.redis).toBeUndefined();
    expect(project.services.postgres).toBeDefined();
    expect(groups.get("infra")).toEqual(["postgres"]);
    expect(project.services.postgres._combined?.allServices).toEqual(["postgres"]);
    // Api's dependsOn drops redis but keeps postgres.
    expect(project.services.api.dependsOn).toEqual(["postgres"]);
    // The group still has a surviving child, so its shared pane stays.
    expect(project.layout).toEqual({
      direction: "columns",
      children: [{ pane: "infra" }, { pane: "api" }],
    });
  });

  it("cascades: stripping the group owner degrades the whole group and removes its pane", () => {
    const { project, groups } = makeExpandedProject();
    stripUnavailableServices(project, new Set(["postgres"]), groups);

    // Owner stripped -> redis (non-owner) goes too.
    expect(project.services.postgres).toBeUndefined();
    expect(project.services.redis).toBeUndefined();
    expect(groups.has("infra")).toBe(false);
    // Api's dependsOn drops both expanded children.
    expect(project.services.api.dependsOn).toEqual([]);
    // Group fully stripped -> its shared pane collapses out of the layout.
    expect(project.layout).toEqual({ pane: "api" });
  });
});

// === loadConfig integration ===

describe("loadConfig with optional services", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-optional-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("strips unavailable service when binary not found", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 1));
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            api: { start: "node server.js" },
            db: { start: "rainfrog -u pg", optional: true },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.api).toBeDefined();
    expect(result.project.services.db).toBeUndefined();
    expect(result.unavailableServices.size).toBe(1);
    expect(result.unavailableServices.get("db")).toEqual({
      name: "db",
      reason: "binary 'rainfrog' not found",
    });
  });

  it("keeps available service when binary found", async () => {
    mockSpawn.mockReturnValue(fakeProc("close", 0));
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            api: { start: "node server.js" },
            db: { start: "rainfrog -u pg", optional: true },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.api).toBeDefined();
    expect(result.project.services.db).toBeDefined();
    expect(result.unavailableServices.size).toBe(0);
  });

  it("strips dependsOn references to unavailable service", async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const [, cmdStr] = args;
      if (cmdStr.includes("rainfrog")) {
        return fakeProc("close", 1);
      }
      return fakeProc("close", 0);
    });
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            api: { start: "node server.js", dependsOn: ["db"] },
            db: { start: "rainfrog -u pg", optional: true },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.api.dependsOn).toEqual([]);
    expect(result.project.services.db).toBeUndefined();
  });
});
