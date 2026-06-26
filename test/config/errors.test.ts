import { describe, expect, it } from "vitest";

import { ConfigError } from "../../src/config/errors.js";

describe("ConfigError", () => {
  it("defaults kind to validation", () => {
    const err = new ConfigError("boom");
    expect(err.kind).toBe("validation");
  });

  it("accepts a custom kind", () => {
    const err = new ConfigError("boom", { kind: "fatal" });
    expect(err.kind).toBe("fatal");
  });

  it("carries attribution fields", () => {
    const err = new ConfigError("boom", {
      kind: "notFound",
      file: "/abs/.zaps.ts",
      service: "api",
      task: "seed",
      field: "cwd",
    });
    expect(err.file).toBe("/abs/.zaps.ts");
    expect(err.service).toBe("api");
    expect(err.task).toBe("seed");
    expect(err.field).toBe("cwd");
  });

  it("leaves attribution fields undefined by default", () => {
    const err = new ConfigError("boom");
    expect(err.file).toBeUndefined();
    expect(err.service).toBeUndefined();
    expect(err.task).toBeUndefined();
    expect(err.field).toBeUndefined();
  });

  it("sets name to ConfigError and extends Error", () => {
    const err = new ConfigError("boom");
    expect(err.name).toBe("ConfigError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConfigError);
  });

  it("keeps message plain (no ANSI escape codes)", () => {
    const err = new ConfigError("config evaluation timed out");
    expect(err.message).toBe("config evaluation timed out");
    expect(err.message).not.toContain(String.fromCharCode(27));
  });
});
