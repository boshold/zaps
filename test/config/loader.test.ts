import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
