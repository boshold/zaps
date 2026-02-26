import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  CliError,
  formatTable,
  resolveCommand,
  resolveRuntime,
  resolveTargetSession,
} from "../../src/cli/helpers.js";
import type { SessionInfo } from "../../src/cli/helpers.js";

describe("CliError", () => {
  it("is an Error with name CliError", () => {
    const err = new CliError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CliError");
    expect(err.message).toBe("test");
  });
});

describe("resolveCommand", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    process.argv = [...originalArgv];
    delete process.env["ZAPS_COMMAND"];
  });

  it("returns ZAPS_COMMAND env when set", () => {
    process.env["ZAPS_COMMAND"] = "my-zaps";
    expect(resolveCommand()).toBe("my-zaps");
  });

  it("returns execPath basename for bunfs", () => {
    process.argv[1] = "/$bunfs/root/main.js";
    const result = resolveCommand();
    // Should be basename of execPath
    expect(typeof result).toBe("string");
  });

  it("returns argv[0] + argv[1] for source mode", () => {
    process.argv = ["/usr/bin/node", "/path/to/cli.js", "up"];
    const result = resolveCommand();
    expect(result).toBe("/usr/bin/node /path/to/cli.js");
  });
});

describe("resolveRuntime", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = [...originalArgv];
    delete process.env["ZAPS_RUNTIME"];
  });

  it("returns env value when set", () => {
    process.env["ZAPS_RUNTIME"] = "custom";
    expect(resolveRuntime()).toBe("custom");
  });

  it('returns "native" for bunfs', () => {
    process.argv[1] = "/$bunfs/root/main.js";
    expect(resolveRuntime()).toBe("native");
  });

  it('returns "source" by default', () => {
    process.argv = ["/usr/bin/node", "/path/to/cli.js"];
    expect(resolveRuntime()).toBe("source");
  });
});

describe("resolveTargetSession", () => {
  const sessions: SessionInfo[] = [
    { id: "abc123", name: "project-a", projectDir: "/a" },
    { id: "def456", name: "project-b", projectDir: "/b" },
    { id: "ghi789", name: "project-c", projectDir: "/c" },
  ];

  it("returns exact id match", () => {
    expect(resolveTargetSession(sessions, "abc123")).toBe(sessions[0]);
  });

  it("returns exact name match", () => {
    expect(resolveTargetSession(sessions, "project-b")).toBe(sessions[1]);
  });

  it("returns single prefix match by id", () => {
    expect(resolveTargetSession(sessions, "ghi")).toBe(sessions[2]);
  });

  it("returns single prefix match by name", () => {
    expect(resolveTargetSession(sessions, "project-c")).toBe(sessions[2]);
  });

  it("throws on ambiguous prefix", () => {
    expect(() => resolveTargetSession(sessions, "project-")).toThrow(CliError);
    expect(() => resolveTargetSession(sessions, "project-")).toThrow(/Ambiguous session/);
  });

  it("throws when session not found", () => {
    expect(() => resolveTargetSession(sessions, "zzz")).toThrow(CliError);
    expect(() => resolveTargetSession(sessions, "zzz")).toThrow(/Session not found/);
  });

  it("returns single session when no arg", () => {
    const single = [sessions[0]];
    expect(resolveTargetSession(single)).toBe(sessions[0]);
  });

  it("matches by cwd when multiple sessions and no arg", () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/b");
    expect(resolveTargetSession(sessions)).toBe(sessions[1]);
    spy.mockRestore();
  });

  it("throws when multiple sessions and no cwd match", () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent");
    expect(() => resolveTargetSession(sessions)).toThrow(CliError);
    expect(() => resolveTargetSession(sessions)).toThrow(/Multiple sessions/);
    spy.mockRestore();
  });

  it("prefers exact id over exact name", () => {
    const dupes: SessionInfo[] = [
      { id: "abc", name: "xyz", projectDir: "/1" },
      { id: "xyz", name: "abc", projectDir: "/2" },
    ];
    // "abc" should match first by exact id
    expect(resolveTargetSession(dupes, "abc")).toBe(dupes[0]);
  });
});

describe("formatTable", () => {
  it("returns empty string for no rows", () => {
    expect(formatTable([])).toBe("");
  });

  it("formats single row", () => {
    expect(formatTable([["a", "b"]])).toBe("a  b");
  });

  it("aligns columns", () => {
    const result = formatTable([
      ["NAME", "STATE"],
      ["api", "ready"],
      ["database", "stopped"],
    ]);
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
    // Column widths should be consistent
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("STATE");
    expect(lines[2]).toContain("database");
  });

  it("pads shorter values", () => {
    const result = formatTable([
      ["a", "bb"],
      ["cc", "d"],
    ]);
    const lines = result.split("\n");
    // First column width = 2 (from "cc")
    expect(lines[0]).toBe("a   bb");
    expect(lines[1]).toBe("cc  d ");
  });
});
