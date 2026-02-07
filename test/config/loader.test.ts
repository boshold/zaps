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

    const result = await loadConfig(configPath);
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
      "Service 'api' must have 'start' or 'run' command",
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
