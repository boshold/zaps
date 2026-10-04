import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readPortState,
  sentraDbPath,
  sentraPortStatePath,
  sentraStateDir,
  writePortState,
} from "#src/lib/sentra/paths.js";

let stateHome = "";

beforeEach(() => {
  stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-sentra-paths-"));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(stateHome, { recursive: true, force: true });
});

describe("sentra paths", () => {
  it("uses $XDG_STATE_HOME/zaps", () => {
    expect(sentraStateDir()).toBe(path.join(stateHome, "zaps"));
    expect(sentraDbPath()).toBe(path.join(stateHome, "zaps", "sentra.db"));
    expect(sentraPortStatePath()).toBe(path.join(stateHome, "zaps", "sentra.json"));
  });

  it.each(["", "relative/state"])("falls back to ~/.local/state/zaps for %j", (value) => {
    vi.stubEnv("XDG_STATE_HOME", value);
    expect(sentraStateDir()).toBe(path.join(os.homedir(), ".local", "state", "zaps"));
  });

  it("falls back when XDG_STATE_HOME is unset", () => {
    vi.stubEnv("XDG_STATE_HOME", undefined);
    expect(sentraStateDir()).toBe(path.join(os.homedir(), ".local", "state", "zaps"));
  });
});

describe("port state", () => {
  function writeRaw(content: string): void {
    fs.mkdirSync(path.dirname(sentraPortStatePath()), { recursive: true });
    fs.writeFileSync(sentraPortStatePath(), content);
  }

  it("returns null when the file is missing", () => {
    expect(readPortState()).toBeNull();
  });

  it("round-trips a written port and creates the directory", () => {
    writePortState(43_210);
    expect(readPortState()).toBe(43_210);
    expect(JSON.parse(fs.readFileSync(sentraPortStatePath(), "utf8"))).toEqual({ port: 43_210 });
    expect(fs.readdirSync(path.dirname(sentraPortStatePath()))).toEqual(["sentra.json"]);
  });

  it("returns null for invalid JSON", () => {
    writeRaw("{not json");
    expect(readPortState()).toBeNull();
  });

  it.each(['{"port":"80"}', '{"port":0}', '{"port":70000}', '{"port":1.5}', "{}", "null"])(
    "returns null for invalid shape %s",
    (content) => {
      writeRaw(content);
      expect(readPortState()).toBeNull();
    },
  );

  it("rejects writing an invalid port", () => {
    expect(() => writePortState(0)).toThrow();
  });
});
