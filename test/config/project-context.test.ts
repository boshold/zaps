import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectContext } from "../../src/config/project-context.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-project-context-"));
  dirs.push(dir);
  return dir;
}

describe("loadProjectContext", () => {
  it("exposes project .env to config evaluation with shell precedence", async () => {
    const dir = project();
    const configPath = path.join(dir, ".zaps.mts");
    fs.writeFileSync(
      configPath,
      `export function config({ define }) {
        return define({
          name: process.env.PROJECT_NAME,
          services: { app: { start: process.env.START_COMMAND } },
        });
      }`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, ".env"),
      "PROJECT_NAME=from-project\nSTART_COMMAND=from-project\n",
      "utf8",
    );

    const loaded = await loadProjectContext(configPath, dir, { START_COMMAND: "from-shell" });

    expect(loaded.config.project.name).toBe("from-project");
    expect(loaded.config.project.services.app.start).toBe("from-shell");
    expect(loaded.env).toMatchObject({
      PROJECT_NAME: "from-project",
      START_COMMAND: "from-shell",
    });
  });

  it("rejects cwd that depends on its own .env", async () => {
    const dir = project();
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    const configPath = path.join(dir, ".zaps.mts");
    fs.writeFileSync(
      configPath,
      `export function config({ define }) {
        return define({
          cwd: process.env.PROJECT_CWD ?? ".",
          services: { app: { start: "true" } },
        });
      }`,
      "utf8",
    );
    fs.writeFileSync(path.join(dir, ".env"), `PROJECT_CWD=${other}\n`, "utf8");

    await expect(loadProjectContext(configPath, dir, {})).rejects.toThrow(
      "Project cwd changed after loading",
    );
  });
});
