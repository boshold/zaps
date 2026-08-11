import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_SOCKET,
  buildAttachArgs,
  buildCreateArgs,
  buildRespawnArgs,
  buildSetPaneOptionArgs,
  buildSetSessionOptionArgs,
  hasManagedSession,
  killStaleSession,
  managedSessionName,
  sanitizeProjectName,
  tmuxAvailable,
  waitForPaneSettled,
} from "../../src/lib/managed-tmux.js";

/** Minimal stand-in for the managed-socket handle; every probe takes one. */
function fakeTmux(overrides: Partial<Parameters<typeof hasManagedSession>[1]> = {}) {
  return {
    hasSession: vi.fn().mockResolvedValue(false),
    killSession: vi.fn().mockResolvedValue(undefined),
    tmuxVersion: vi.fn().mockResolvedValue({ major: 3, minor: 5 }),
    displayMessage: vi.fn().mockResolvedValue("0 "),
    ...overrides,
  };
}

describe("sanitizeProjectName", () => {
  it.each([
    ["my-app", "my-app"],
    ["My App", "my-app"],
    ["app.v2", "app-v2"],
    ["host:1234", "host-1234"],
    ["Bücher", "b-cher"],
    [String.raw`a//b\c`, "a-b-c"],
    ["snake_case-2", "snake_case-2"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeProjectName(input)).toBe(expected);
  });

  it("never emits a character tmux rejects in a session name", () => {
    const sanitized = sanitizeProjectName("weird.name:with/slashes and spaces");
    expect(sanitized).not.toMatch(/[.:]/u);
    expect(sanitized).toMatch(/^[a-z0-9_-]+$/u);
  });

  it("collapses runs and trims leading/trailing separators", () => {
    expect(sanitizeProjectName("  ...weird---name...  ")).toBe("weird-name");
  });

  it("truncates to 30 chars without leaving a trailing separator", () => {
    const sanitized = sanitizeProjectName(`${"a".repeat(30)} tail`);
    expect(sanitized).toHaveLength(30);
    expect(sanitized.endsWith("-")).toBe(false);
  });

  it("falls back to 'project' when nothing survives", () => {
    expect(sanitizeProjectName("....")).toBe("project");
    expect(sanitizeProjectName("")).toBe("project");
  });
});

describe("managedSessionName", () => {
  it("builds zaps-<sanitized>-<sessionId>", () => {
    expect(managedSessionName("My App", "a1b2c3d4e5f6")).toBe("zaps-my-app-a1b2c3d4e5f6");
  });

  it("is deterministic for the same inputs", () => {
    expect(managedSessionName("app", "abc123abc123")).toBe(
      managedSessionName("app", "abc123abc123"),
    );
  });

  it("separates projects that share a display name via the session id", () => {
    expect(managedSessionName("app", "aaaaaaaaaaaa")).not.toBe(
      managedSessionName("app", "bbbbbbbbbbbb"),
    );
  });

  it("stays a valid tmux session name for hostile input", () => {
    expect(managedSessionName("v1.2:beta build", "abc123abc123")).toBe(
      "zaps-v1-2-beta-build-abc123abc123",
    );
  });
});

describe("argv builders", () => {
  it("builds the create invocation from 50_api", () => {
    expect(buildCreateArgs({ name: "zaps-app-abc123", zapsArgv: ["/usr/bin/zaps", "up"] })).toEqual(
      [
        "-L",
        "zaps",
        "new-session",
        "-s",
        "zaps-app-abc123",
        "-e",
        "ZAPS_TMUX_SOCKET=zaps",
        "-e",
        "ZAPS_MANAGED_TMUX=1",
        "--",
        "/usr/bin/zaps",
        "up",
      ],
    );
  });

  it("inserts -d before -s for the detached create path", () => {
    const args = buildCreateArgs({
      name: "zaps-app-abc123",
      detach: true,
      zapsArgv: ["zaps", "up", "-d"],
    });
    expect(args.slice(0, 6)).toEqual(["-L", "zaps", "new-session", "-d", "-s", "zaps-app-abc123"]);
    expect(args.slice(-4)).toEqual(["--", "zaps", "up", "-d"]);
  });

  it("passes the zaps argv as separate elements, never a joined string", () => {
    const args = buildCreateArgs({
      name: "n",
      zapsArgv: ["/path with spaces/zaps", "up"],
    });
    expect(args).toContain("/path with spaces/zaps");
    expect(args.some((arg) => arg.includes("zaps up"))).toBe(false);
  });

  it("builds the attach invocation", () => {
    expect(buildAttachArgs("zaps-app-abc123")).toEqual([
      "-L",
      "zaps",
      "attach-session",
      "-t",
      "zaps-app-abc123",
    ]);
  });

  it("builds respawn in argv form targeting a pane id", () => {
    expect(buildRespawnArgs("%7", ["zaps", "attach"])).toEqual([
      "-L",
      "zaps",
      "respawn-pane",
      "-t",
      "%7",
      "--",
      "zaps",
      "attach",
    ]);
  });

  it("builds the session + pane option invocations", () => {
    expect(buildSetSessionOptionArgs("zaps-app-abc123", "destroy-unattached", "off")).toEqual([
      "-L",
      "zaps",
      "set-option",
      "-t",
      "zaps-app-abc123",
      "destroy-unattached",
      "off",
    ]);
    // `-p` makes it pane-level so it beats any global user setting.
    expect(buildSetPaneOptionArgs("%0", "remain-on-exit", "on")).toEqual([
      "-L",
      "zaps",
      "set-option",
      "-p",
      "-t",
      "%0",
      "remain-on-exit",
      "on",
    ]);
  });

  it("targets the managed socket in every builder", () => {
    for (const args of [
      buildCreateArgs({ name: "n", zapsArgv: ["zaps"] }),
      buildAttachArgs("n"),
      buildRespawnArgs("%0", ["zaps"]),
      buildSetSessionOptionArgs("n", "o", "v"),
      buildSetPaneOptionArgs("%0", "o", "v"),
    ]) {
      expect(args.slice(0, 2)).toEqual(["-L", MANAGED_SOCKET]);
    }
  });
});

describe("hasManagedSession", () => {
  it("reports what the managed server says", async () => {
    const tmux = fakeTmux({ hasSession: vi.fn().mockResolvedValue(true) });
    await expect(hasManagedSession("zaps-app-abc123", tmux)).resolves.toBe(true);
    expect(tmux.hasSession).toHaveBeenCalledWith("zaps-app-abc123");
  });
});

describe("killStaleSession", () => {
  it("kills the named session and reports it", async () => {
    const tmux = fakeTmux();
    await expect(killStaleSession("zaps-app-abc123", tmux)).resolves.toBe(true);
    expect(tmux.killSession).toHaveBeenCalledWith("zaps-app-abc123");
  });

  it("treats an already-gone session as a no-op, not an error", async () => {
    const tmux = fakeTmux({
      killSession: vi.fn().mockRejectedValue(new Error("session not found")),
    });
    await expect(killStaleSession("zaps-app-abc123", tmux)).resolves.toBe(false);
  });
});

describe("tmuxAvailable", () => {
  it("accepts the minimum supported version", async () => {
    await expect(tmuxAvailable(fakeTmux())).resolves.toEqual({ ok: true, version: "3.5" });
  });

  it("accepts newer majors and minors", async () => {
    const newer = fakeTmux({ tmuxVersion: vi.fn().mockResolvedValue({ major: 4, minor: 0 }) });
    await expect(tmuxAvailable(newer)).resolves.toEqual({ ok: true, version: "4.0" });
  });

  it("reports 'missing' when tmux is absent or unparsable", async () => {
    const absent = fakeTmux({ tmuxVersion: vi.fn().mockResolvedValue(null) });
    await expect(tmuxAvailable(absent)).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("reports 'too-old' with the version for the F8 message", async () => {
    const old = fakeTmux({ tmuxVersion: vi.fn().mockResolvedValue({ major: 3, minor: 2 }) });
    await expect(tmuxAvailable(old)).resolves.toEqual({
      ok: false,
      reason: "too-old",
      version: "3.2",
    });
    const olderMajor = fakeTmux({ tmuxVersion: vi.fn().mockResolvedValue({ major: 2, minor: 9 }) });
    await expect(tmuxAvailable(olderMajor)).resolves.toMatchObject({ reason: "too-old" });
  });
});

describe("waitForPaneSettled", () => {
  it("returns the inner exit code once the pane is dead", async () => {
    const tmux = fakeTmux({ displayMessage: vi.fn().mockResolvedValue("1 42") });
    await expect(waitForPaneSettled("%0", { tmux, pollMs: 1 })).resolves.toEqual({
      settled: true,
      exitCode: 42,
    });
    expect(tmux.displayMessage).toHaveBeenCalledWith("%0", "#{pane_dead} #{pane_dead_status}");
  });

  it("polls until the pane dies rather than sleeping a fixed time", async () => {
    const displayMessage = vi
      .fn()
      .mockResolvedValueOnce("0 ")
      .mockResolvedValueOnce("0 ")
      .mockResolvedValue("1 0");
    await expect(
      waitForPaneSettled("%0", { tmux: fakeTmux({ displayMessage }), pollMs: 1 }),
    ).resolves.toEqual({ settled: true, exitCode: 0 });
    expect(displayMessage).toHaveBeenCalledTimes(3);
  });

  it("treats a dead pane with no readable status as exit 0", async () => {
    const tmux = fakeTmux({ displayMessage: vi.fn().mockResolvedValue("1 ") });
    await expect(waitForPaneSettled("%0", { tmux, pollMs: 1 })).resolves.toEqual({
      settled: true,
      exitCode: 0,
    });
  });

  it("reports 'gone' when the pane or its session disappeared", async () => {
    const tmux = fakeTmux({
      displayMessage: vi.fn().mockRejectedValue(new Error("can't find pane")),
    });
    await expect(waitForPaneSettled("%0", { tmux, pollMs: 1 })).resolves.toEqual({
      settled: false,
      reason: "gone",
    });
  });

  it("gives up at the deadline while the pane is still alive", async () => {
    const tmux = fakeTmux();
    await expect(waitForPaneSettled("%0", { tmux, pollMs: 1, timeoutMs: 30 })).resolves.toEqual({
      settled: false,
      reason: "timeout",
    });
    expect(tmux.displayMessage).toHaveBeenCalled();
  });
});
