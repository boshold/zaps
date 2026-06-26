import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError } from "../../../src/config/errors.js";
import { createFindHelpers } from "../../../src/config/helpers/find.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zaps-find-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(invokeDir: string, configDir = tmpDir) {
  return { invokeDir, configDir };
}

describe("find.up", () => {
  it("returns a CwdResolver function (never null)", () => {
    const { up } = createFindHelpers();
    expect(typeof up("package.json")).toBe("function");
  });

  it("returns the directory containing the file, walking upward", () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "a", "package.json"), "{}");

    const { up } = createFindHelpers();
    const resolver = up("package.json");
    expect(resolver(ctx(nested))).toBe(path.join(tmpDir, "a"));
  });

  it("returns invokeDir itself when the file lives there", () => {
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "");
    const { up } = createFindHelpers();
    expect(up("Cargo.toml")(ctx(tmpDir))).toBe(tmpDir);
  });

  it("throws ConfigError(notFound) with a default message when not found", () => {
    const { up } = createFindHelpers();
    const resolver = up("never-exists.json");
    let caught: unknown;
    try {
      resolver(ctx(tmpDir));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({ kind: "notFound", field: "cwd" });
    expect((caught as ConfigError).message).toContain("never-exists.json");
    expect((caught as ConfigError).message).toContain(tmpDir);
  });

  it("uses opts.orFatal as the thrown message", () => {
    const { up } = createFindHelpers();
    const resolver = up("Cargo.toml", { orFatal: "Run zaps inside a Rust crate" });
    expect(() => resolver(ctx(tmpDir))).toThrow("Run zaps inside a Rust crate");
  });

  it("stops at a static stopAt path before reaching a higher match", () => {
    const sub = path.join(tmpDir, "sub");
    const deep = path.join(sub, "deep");
    fs.mkdirSync(deep, { recursive: true });
    // Match exists ABOVE the stopAt boundary — must NOT be found.
    fs.writeFileSync(path.join(tmpDir, "marker"), "");

    const { up } = createFindHelpers();
    const resolver = up("marker", { stopAt: sub });
    expect(() => resolver(ctx(deep))).toThrow(ConfigError);
  });

  it("stops at a static stopAt path that contains the file", () => {
    const sub = path.join(tmpDir, "sub");
    const deep = path.join(sub, "deep");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(sub, "marker"), "");

    const { up } = createFindHelpers();
    const resolver = up("marker", { stopAt: sub });
    expect(resolver(ctx(deep))).toBe(sub);
  });

  it('stopAt: "config" stops at ctx.configDir', () => {
    const configDir = path.join(tmpDir, "cfg");
    const deep = path.join(configDir, "x", "y");
    fs.mkdirSync(deep, { recursive: true });
    // Match above the configDir boundary — must NOT be found.
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");

    const { up } = createFindHelpers();
    const resolver = up("package.json", { stopAt: "config" });
    expect(() => resolver(ctx(deep, configDir))).toThrow(ConfigError);
  });
});
