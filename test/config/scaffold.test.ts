import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateTemplate, scaffoldConfig } from "../../src/config/scaffold.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-scaffold-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateTemplate", () => {
  it("returns valid TS string with default project name", async () => {
    const result = await generateTemplate();
    expect(result).toContain('name: "my-project"');
    expect(result).toContain("defineProject");
    expect(result).toContain("import type");
  });

  it("includes custom project name", async () => {
    const result = await generateTemplate("foo");
    expect(result).toContain('name: "foo"');
    expect(result).not.toContain("my-project");
  });

  it("replaces zaps import path", async () => {
    const result = await generateTemplate();
    expect(result).toContain('from "zaps"');
    expect(result).not.toContain("{{ZAPS_PATH}}");
  });

  it("does not contain unreplaced placeholders", async () => {
    const result = await generateTemplate("bar");
    expect(result).not.toContain("{{PROJECT_NAME}}");
    expect(result).not.toContain("{{ZAPS_PATH}}");
  });
});

describe("scaffoldConfig", () => {
  it("writes .zaps.mts file to disk and returns path", async () => {
    const result = await scaffoldConfig(tmpDir, "test-project");
    const expected = path.join(tmpDir, ".zaps.mts");
    expect(result).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);

    const content = fs.readFileSync(expected, "utf8");
    expect(content).toContain('name: "test-project"');
  });

  it("throws if .zaps.mts already exists", async () => {
    fs.writeFileSync(path.join(tmpDir, ".zaps.mts"), "");
    await expect(scaffoldConfig(tmpDir)).rejects.toThrow("Config file already exists");
  });

  it("throws if .zaps.ts already exists", async () => {
    fs.writeFileSync(path.join(tmpDir, ".zaps.ts"), "");
    await expect(scaffoldConfig(tmpDir)).rejects.toThrow("Config file already exists");
  });

  it("throws if .local.zaps.mts already exists", async () => {
    fs.writeFileSync(path.join(tmpDir, ".local.zaps.mts"), "");
    await expect(scaffoldConfig(tmpDir)).rejects.toThrow("Config file already exists");
  });

  it("throws if .local.zaps.ts already exists", async () => {
    fs.writeFileSync(path.join(tmpDir, ".local.zaps.ts"), "");
    await expect(scaffoldConfig(tmpDir)).rejects.toThrow("Config file already exists");
  });

  it("uses default project name when none provided", async () => {
    const result = await scaffoldConfig(tmpDir);
    const content = fs.readFileSync(result, "utf8");
    expect(content).toContain('name: "my-project"');
  });
});
