import { describe, expect, it } from "vitest";

import { CliError, formatTable, resolveTargetSession } from "#src/cli/helpers.js";
import type { SessionInfo } from "#src/cli/helpers.js";

const sessions: SessionInfo[] = [
  { id: "abc123def456", name: "my-app", projectDir: "/projects/my-app" },
  { id: "xyz789ghi012", name: "api-server", projectDir: "/projects/api-server" },
  { id: "abc999zzz000", name: "other", projectDir: "/projects/other" },
];

describe("resolveTargetSession", () => {
  it("matches exact id", () => {
    const result = resolveTargetSession(sessions, "abc123def456");
    expect(result.id).toBe("abc123def456");
    expect(result.name).toBe("my-app");
  });

  it("matches exact name", () => {
    const result = resolveTargetSession(sessions, "api-server");
    expect(result.id).toBe("xyz789ghi012");
  });

  it("matches id prefix (unique)", () => {
    const result = resolveTargetSession(sessions, "xyz");
    expect(result.id).toBe("xyz789ghi012");
  });

  it("matches name prefix (unique)", () => {
    const result = resolveTargetSession(sessions, "api-");
    expect(result.id).toBe("xyz789ghi012");
  });

  it("throws CliError on ambiguous prefix", () => {
    // "abc" matches both abc123def456 and abc999zzz000
    expect(() => resolveTargetSession(sessions, "abc")).toThrow(CliError);
    expect(() => resolveTargetSession(sessions, "abc")).toThrow(/Ambiguous session/);
  });

  it("throws CliError when not found", () => {
    expect(() => resolveTargetSession(sessions, "zzz-no-match")).toThrow(CliError);
    expect(() => resolveTargetSession(sessions, "zzz-no-match")).toThrow(/Session not found/);
  });

  it("auto-selects when no arg and single session", () => {
    const single = [sessions[0]];
    const result = resolveTargetSession(single);
    expect(result.id).toBe("abc123def456");
  });

  it("throws CliError when no arg and multiple sessions", () => {
    expect(() => resolveTargetSession(sessions)).toThrow(CliError);
    expect(() => resolveTargetSession(sessions)).toThrow(/Multiple sessions/);
  });
});

describe("formatTable", () => {
  it("pads columns correctly", () => {
    const rows = [
      ["id", "name", "dir"],
      ["abc123", "my-app", "/projects/a"],
      ["x", "b", "/p"],
    ];
    const result = formatTable(rows);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    // All lines should have same column alignment
    // "id" padded to 6 (length of "abc123"), "name" padded to 6 (length of "my-app")
    expect(lines[0]).toBe("id      name    dir        ");
    expect(lines[1]).toBe("abc123  my-app  /projects/a");
    expect(lines[2]).toBe("x       b       /p         ");
  });

  it("returns empty string for empty rows", () => {
    expect(formatTable([])).toBe("");
  });
});
