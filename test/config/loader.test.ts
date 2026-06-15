import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/loader.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-loader-"));
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

describe("loadConfig", () => {
  it("loads a valid config and returns ResolvedConfig", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test-project",
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.name).toBe("test-project");
    expect(result.configPath).toBe(configPath);
    expect(result.projectDir).toBe(tmpDir);
  });

  it("loads default export", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export default function(z) {
        return z.defineProject({
          name: "default-export",
          services: { app: { start: "node index.js" } },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);
    expect(result.project.name).toBe("default-export");
  });

  it("defaults projectDir to invokeDir", async () => {
    const invokeDir = path.join(tmpDir, "subproject");
    fs.mkdirSync(invokeDir, { recursive: true });

    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, invokeDir);
    expect(result.projectDir).toBe(invokeDir);
  });

  it("resolves cwd string relative to configDir", async () => {
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });

    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          cwd: "./sub",
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, "/some/invoke/dir");
    expect(result.projectDir).toBe(subDir);
  });

  it("uses absolute cwd string as-is", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          cwd: "/absolute/path",
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.projectDir).toBe("/absolute/path");
  });

  it("resolves cwd function", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          cwd: ({ invokeDir }) => invokeDir,
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const invokeDir = path.join(tmpDir, "project");
    fs.mkdirSync(invokeDir, { recursive: true });

    const result = await loadConfig(configPath, invokeDir);
    expect(result.projectDir).toBe(invokeDir);
  });

  it("resolves relative cwd function result relative to configDir", async () => {
    const subDir = path.join(tmpDir, "rel");
    fs.mkdirSync(subDir, { recursive: true });

    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          cwd: () => "./rel",
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, "/some/dir");
    expect(result.projectDir).toBe(subDir);
  });

  it("defaults name to directory basename when omitted", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          services: {
            api: { start: "npm run dev" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.name).toBe(path.basename(tmpDir));
  });

  it("config can use node built-ins", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        const dir = z.node.path.join("/foo", "bar");
        return z.defineProject({
          name: "node-test",
          cwd: dir,
          services: {
            api: { start: "npm start" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.name).toBe("node-test");
    expect(result.projectDir).toBe("/foo/bar");
  });

  it("re-evaluates transitively imported helper on reload", async () => {
    writeConfig("helper.mts", `export const projectName = "first-value";`);
    const configPath = writeConfig(
      "fixture.zaps.mts",
      `
      import { projectName } from "./helper.mts";
      export function config(z) {
        return z.defineProject({
          name: projectName,
          services: { api: { start: "npm run dev" } },
        });
      }
    `,
    );

    const first = await loadConfig(configPath, tmpDir);
    expect(first.project.name).toBe("first-value");

    writeConfig("helper.mts", `export const projectName = "second-value";`);

    const second = await loadConfig(configPath, tmpDir);
    expect(second.project.name).toBe("second-value");
  });

  it("loads a config from a path containing '#'", async () => {
    const hashDir = path.join(tmpDir, "branch#1");
    fs.mkdirSync(hashDir, { recursive: true });
    const configPath = path.join(hashDir, ".zaps.ts");
    fs.writeFileSync(
      configPath,
      `
      export function config(z) {
        return z.defineProject({
          name: "hash-path",
          services: { api: { start: "npm run dev" } },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, hashDir);
    expect(result.project.name).toBe("hash-path");
  });

  it("warns when an autostart service depends on a non-autostart service", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            db: { start: "start-db", flags: { start: false } },
            api: { start: "start-api", dependsOn: ["db"] },
          },
        });
      }
    `,
    );

    await loadConfig(configPath, tmpDir);

    const warnings = writeSpy.mock.calls.map(([msg]) => String(msg)).join("");
    expect(warnings).toContain("service 'api' depends on non-autostart service 'db'");
    writeSpy.mockRestore();
  });

  it("throws when no export found", async () => {
    const configPath = writeConfig(".zaps.ts", `export const notAConfig = 42;`);

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Config file must export a 'config' function or default export",
    );
  });

  it("throws when service has no start/run", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: { api: {} },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Service 'api' must have 'start', 'run', or 'docker' config",
    );
  });

  it("throws on unknown dependsOn ref", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            api: { start: "npm start", dependsOn: ["redis"] },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Service 'api' references unknown dependency 'redis'",
    );
  });

  it("throws on circular dependencies", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            a: { start: "a", dependsOn: ["b"] },
            b: { start: "b", dependsOn: ["a"] },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Circular dependency detected");
  });

  it("throws on unknown layout pane", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: { api: { start: "npm start" } },
          layout: {
            direction: "columns",
            children: [
              { pane: "@tui" },
              { pane: "cache" },
            ],
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Layout references unknown pane 'cache'");
  });

  it("throws when detached service appears in layout", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            db: { start: "docker compose up", detached: true },
            api: { start: "npm start" },
          },
          layout: {
            direction: "columns",
            children: [
              { pane: "@tui" },
              { pane: "db" },
            ],
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Detached service 'db' must not appear in layout",
    );
  });

  it("throws when restartWith entry is not in dependsOn", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            db: { start: "start-db" },
            api: { start: "start-api", dependsOn: ["db"], restartWith: ["cache"] },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Service 'api' restartWith 'cache' is not in dependsOn",
    );
  });

  it("accepts valid restartWith subset of dependsOn", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            db: { start: "start-db" },
            cache: { start: "start-cache" },
            api: { start: "start-api", dependsOn: ["db", "cache"], restartWith: ["db"] },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.api.restartWith).toEqual(["db"]);
  });

  it("throws on unknown task dependsOn ref", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: { api: { start: "npm start" } },
          tasks: {
            migrate: { name: "Migrate", commands: "db:migrate", dependsOn: ["nonexistent"] },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Task 'migrate' references unknown dependency 'nonexistent'",
    );
  });
});

describe("docker expand", () => {
  it("expands docker services with expand: true", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: { service: ["postgres", "redis"], expand: true },
              restart: { maxRetries: 3 },
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);

    // Parent "infra" should be removed
    expect(result.project.services.infra).toBeUndefined();
    // Children should exist
    expect(result.project.services.postgres).toBeDefined();
    expect(result.project.services.redis).toBeDefined();
    // Children inherit restart config
    expect(result.project.services.postgres.restart?.maxRetries).toBe(3);
    // Children have _combined metadata
    expect(result.project.services.postgres._combined?.group).toBe("infra");
    expect(result.project.services.postgres._combined?.isOwner).toBe(true);
    expect(result.project.services.redis._combined?.isOwner).toBe(false);
    expect(result.project.services.redis._combined?.allServices).toEqual(["postgres", "redis"]);
    // Non-owner implicitly depends on owner
    expect(result.project.services.redis.dependsOn).toContain("postgres");
    // Groups map
    expect(result.groups.get("infra")).toEqual(["postgres", "redis"]);
  });

  it("rewrites dependsOn referencing group name", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: { service: ["postgres", "redis"], expand: true },
            },
            api: {
              start: "node server.js",
              dependsOn: ["infra"],
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);
    // DependsOn: ["infra"] should expand to ["postgres", "redis"]
    expect(result.project.services.api.dependsOn).toEqual(["postgres", "redis"]);
  });

  it("throws on naming collision", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: { service: ["api"], expand: true },
            },
            api: {
              start: "node server.js",
            },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Docker expand collision");
  });

  it("layout accepts group name as valid pane", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: { service: ["postgres", "redis"], expand: true },
            },
          },
          layout: {
            direction: "columns",
            children: [
              { pane: "@tui", size: "30" },
              { pane: "infra", size: "70" },
            ],
          },
        });
      }
    `,
    );

    // Should not throw — "infra" is a valid group name in layout
    const result = await loadConfig(configPath);
    expect(result.groups.get("infra")).toEqual(["postgres", "redis"]);
  });

  it("expand with per-child overrides merges onto children", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: {
                service: ["caddy", "postgres", "bugsink"],
                expand: {
                  postgres: {
                    onReady: () => console.log("migrated"),
                  },
                  bugsink: {
                    ready: { http: "http://localhost:8000/health" },
                  },
                },
              },
              restart: { maxRetries: 3 },
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);
    // All children exist
    expect(result.project.services.caddy).toBeDefined();
    expect(result.project.services.postgres).toBeDefined();
    expect(result.project.services.bugsink).toBeDefined();
    // Caddy has no overrides — inherits parent restart
    expect(result.project.services.caddy.restart?.maxRetries).toBe(3);
    expect(result.project.services.caddy.onReady).toBeUndefined();
    // Postgres has onReady override
    expect(result.project.services.postgres.onReady).toBeTypeOf("function");
    expect(result.project.services.postgres.restart?.maxRetries).toBe(3);
    // Bugsink has ready override
    expect(result.project.services.bugsink.ready).toEqual({ http: "http://localhost:8000/health" });
  });

  it("expand override for unknown child throws", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: {
                service: ["caddy"],
                expand: {
                  unknown: { ready: { port: 3000 } },
                },
              },
            },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath)).rejects.toThrow("Docker expand override 'unknown'");
  });

  it("returns empty groups when no expand used", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            api: { start: "node server.js" },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);
    expect(result.groups.size).toBe(0);
  });
});
