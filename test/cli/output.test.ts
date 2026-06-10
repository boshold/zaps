import { encode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCodingAgent, resolveFormat, writeData } from "../../src/cli/output.js";

const AGENT_VARS = ["CLAUDECODE", "CURSOR_TRACE_DIR"];

describe("resolveFormat", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of [...AGENT_VARS, "ZAPS_FORMAT"]) {
      saved.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const [key, val] of saved) {
      if (val === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = val;
      }
    }
  });

  function clearAgentVars() {
    for (const key of AGENT_VARS) {
      Reflect.deleteProperty(process.env, key);
    }
    Reflect.deleteProperty(process.env, "ZAPS_FORMAT");
  }

  it("returns json when opts.json is true", () => {
    expect(resolveFormat({ json: true })).toBe("json");
  });

  it("json wins over toon", () => {
    expect(resolveFormat({ json: true, toon: true })).toBe("json");
  });

  it("returns toon when opts.toon is true", () => {
    expect(resolveFormat({ toon: true })).toBe("toon");
  });

  it("ZAPS_FORMAT=json overrides agent detection", () => {
    process.env.ZAPS_FORMAT = "json";
    expect(resolveFormat({})).toBe("json");
  });

  it("ZAPS_FORMAT=toon overrides default text", () => {
    clearAgentVars();
    process.env.ZAPS_FORMAT = "toon";
    expect(resolveFormat({})).toBe("toon");
  });

  it("ignores invalid ZAPS_FORMAT values", () => {
    clearAgentVars();
    process.env.ZAPS_FORMAT = "xml";
    expect(resolveFormat({})).toBe("text");
  });

  it("returns toon when CLAUDECODE env is set", () => {
    clearAgentVars();
    process.env.CLAUDECODE = "1";
    expect(resolveFormat({})).toBe("toon");
  });

  it("returns toon when CURSOR_TRACE_DIR env is set", () => {
    clearAgentVars();
    process.env.CURSOR_TRACE_DIR = "/tmp/cursor";
    expect(resolveFormat({})).toBe("toon");
  });

  it("returns text by default", () => {
    clearAgentVars();
    expect(resolveFormat({})).toBe("text");
  });
});

describe("isCodingAgent", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of AGENT_VARS) {
      saved.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const [key, val] of saved) {
      if (val === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = val;
      }
    }
  });

  function clearAgentVars() {
    for (const key of AGENT_VARS) {
      Reflect.deleteProperty(process.env, key);
    }
  }

  for (const envVar of AGENT_VARS) {
    it(`detects ${envVar}`, () => {
      clearAgentVars();
      process.env[envVar] = "1";
      expect(isCodingAgent()).toBe(true);
    });
  }

  it("returns false when no agent env vars are set", () => {
    clearAgentVars();
    expect(isCodingAgent()).toBe(false);
  });

  it("unknown env var does not trigger detection", () => {
    clearAgentVars();
    process.env.SOME_RANDOM_AGENT = "1";
    expect(isCodingAgent()).toBe(false);
    delete process.env.SOME_RANDOM_AGENT;
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
