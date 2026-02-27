import { encode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveFormat, writeData } from "../../src/cli/output.js";

describe("resolveFormat", () => {
  const origEnv = process.env["CLAUDE_CODE"];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env["CLAUDE_CODE"];
    } else {
      process.env["CLAUDE_CODE"] = origEnv;
    }
  });

  it("returns json when opts.json is true", () => {
    expect(resolveFormat({ json: true })).toBe("json");
  });

  it("json wins over toon", () => {
    expect(resolveFormat({ json: true, toon: true })).toBe("json");
  });

  it("returns toon when opts.toon is true", () => {
    expect(resolveFormat({ toon: true })).toBe("toon");
  });

  it("returns toon when CLAUDE_CODE env is set", () => {
    process.env["CLAUDE_CODE"] = "1";
    expect(resolveFormat({})).toBe("toon");
  });

  it("returns text by default", () => {
    delete process.env["CLAUDE_CODE"];
    expect(resolveFormat({})).toBe("text");
  });
});

describe("writeData", () => {
  let written: string;

  beforeEach(() => {
    written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written += chunk as string;
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes JSON with indentation for json format", () => {
    writeData({ a: 1 }, "json");
    expect(written).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });

  it("writes TOON for toon format", () => {
    writeData({ a: 1 }, "toon");
    expect(written).toBe(`${encode({ a: 1 })}\n`);
  });

  it("writes nothing for text format", () => {
    writeData({ a: 1 }, "text");
    expect(written).toBe("");
  });

  it("handles arrays", () => {
    writeData([], "json");
    expect(written).toBe("[]\n");
  });
});
