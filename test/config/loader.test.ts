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

  it("warns when a task requests a reserved shortcut (q/j/k) and drops it", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: { api: { start: "npm start" } },
          tasks: {
            kill: { name: "Kill", commands: "kill", shortcut: "q" },
            build: { name: "Build", commands: "build", shortcut: "b" },
          },
        });
      }
    `,
    );

    await loadConfig(configPath, tmpDir);

    const warnings = writeSpy.mock.calls.map(([msg]) => String(msg)).join("");
    expect(warnings).toContain("task 'kill'");
    expect(warnings).toContain("reserved shortcut 'q'");
    // A non-reserved shortcut does not warn.
    expect(warnings).not.toContain("task 'build'");
    writeSpy.mockRestore();
  });

  it("strips g/y flags from a ready.output regex and warns", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(z) {
        return z.defineProject({
          name: "test",
          services: {
            api: { start: "npm run dev", ready: { output: /listening/gy } },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    const output = result.project.services.api.ready;
    const re = (output as { output: RegExp }).output;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.flags).not.toMatch(/[gy]/);
    expect(re.source).toBe("listening");

    const warnings = writeSpy.mock.calls.map(([msg]) => String(msg)).join("");
    expect(warnings).toContain("service 'api' ready.output regex");
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
      "Detached service 'db' cannot appear in the layout",
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

  it("expands a string `service` when expand is set (G6)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            db: {
              docker: { expand: true, service: "postgres" },
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath);
    // Parent removed, single child created exactly like service: ["postgres"].
    expect(result.project.services.db).toBeUndefined();
    expect(result.project.services.postgres).toBeDefined();
    expect(result.project.services.postgres._combined?.isOwner).toBe(true);
    expect(result.groups.get("db")).toEqual(["postgres"]);
  });

  it("rejects an expand override using the forbidden 'start' key (G7)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            cache: {
              docker: {
                service: ["caddy", "redis"],
                expand: { redis: { start: "echo hijacked" } },
              },
            },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath, tmpDir)).rejects.toThrow(
      /override for child 'redis' in group 'cache'.*start/s,
    );
  });

  it("rejects an expand override using the forbidden 'docker' key (G7)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            cache: {
              docker: {
                service: ["caddy", "redis"],
                expand: { redis: { docker: { service: "other" } } },
              },
            },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath, tmpDir)).rejects.toThrow(
      /override for child 'redis' in group 'cache'.*docker/s,
    );
  });

  it("rejects an expand override with an unknown/typo key (G7)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            cache: {
              docker: {
                service: ["caddy", "redis"],
                expand: { redis: { redy: { port: 3000 } } },
              },
            },
          },
        });
      }
    `,
    );

    await expect(loadConfig(configPath, tmpDir)).rejects.toThrow(
      /override for child 'redis' in group 'cache'.*redy/s,
    );
  });

  it("accepts a valid expand override (G7)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            cache: {
              docker: {
                service: ["caddy", "redis"],
                expand: { redis: { env: { ROLE: "cache" } } },
              },
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.redis.env).toEqual({ ROLE: "cache" });
  });

  it("evaluates `optional` set in an expand-child override (G3)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            infra: {
              docker: {
                service: ["postgres", "redis"],
                expand: { redis: { optional: () => false } },
              },
            },
          },
        });
      }
    `,
    );

    const result = await loadConfig(configPath, tmpDir);
    // Override optional is evaluated for the child (only possible because expansion
    // Now runs before optional resolution) — redis is stripped, owner survives.
    expect(result.project.services.redis).toBeUndefined();
    expect(result.project.services.postgres).toBeDefined();
    expect(result.groups.get("infra")).toEqual(["postgres"]);
    expect(result.unavailableServices.has("redis")).toBe(true);
  });

  it("degrades gracefully when an expand-child override dependsOn references a stripped optional (G3)", async () => {
    const configPath = writeConfig(
      ".zaps.ts",
      `
      export function config(lib) {
        return lib.defineProject({
          services: {
            stripe: { start: "stripe listen", optional: () => false },
            infra: {
              docker: {
                service: ["postgres", "redis"],
                expand: { redis: { dependsOn: ["stripe"] } },
              },
            },
          },
        });
      }
    `,
    );

    // Old ordering threw "references unknown dependency 'stripe'"; now it degrades.
    const result = await loadConfig(configPath, tmpDir);
    expect(result.project.services.stripe).toBeUndefined();
    expect(result.project.services.redis).toBeDefined();
    expect(result.project.services.redis.dependsOn).not.toContain("stripe");
    expect(result.project.services.redis.dependsOn).toContain("postgres");
  });

  describe("detached validation (E4)", () => {
    it("rejects a detached member of a combined docker group (expand override)", async () => {
      const configPath = writeConfig(
        ".zaps.ts",
        `
        export function config(lib) {
          return lib.defineProject({
            services: {
              cache: {
                docker: {
                  service: ["redis", "memcached"],
                  expand: { redis: { detached: true } },
                },
              },
            },
          });
        }
      `,
      );

      await expect(loadConfig(configPath, tmpDir)).rejects.toThrow(
        /Detached service 'redis' cannot be a member of combined group 'cache'/,
      );
    });
  });
});
