import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/discovery.js", () => ({
  discoverConfig: vi.fn(),
}));

vi.mock("../../src/daemon/lifecycle.js", () => ({
  isDaemonRunning: vi.fn(() => false),
  socketPath: vi.fn(() => "/tmp/test-daemon.sock"),
}));

vi.mock("../../src/daemon/session.js", () => ({
  sessionId: vi.fn((configPath: string) => `session-${configPath}`),
}));

vi.mock("../../src/lib/env.js", () => ({
  getEnv: vi.fn((key: string) => process.env[key]),
}));

vi.mock("../../src/lib/ipc/client.js", () => ({
  ipcRequest: vi.fn(),
  ipcStream: vi.fn(),
}));

import type { DownDeps, SessionInfo } from "../../src/cli/helpers.js";
import {
  CliError,
  DAEMON_NOT_RUNNING,
  formatTable,
  parsePositiveInt,
  resolveCommand,
  resolveCommandArgv,
  resolveListedSessionId,
  resolveRuntime,
  resolveSessionId,
  resolveTargetSession,
  runDown,
  withDaemon,
} from "../../src/cli/helpers.js";

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

  beforeEach(() => {
    process.argv = [...originalArgv];
    delete process.env.ZAPS_COMMAND;
  });

  it("returns ZAPS_COMMAND env when set", () => {
    process.env.ZAPS_COMMAND = "my-zaps";
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

describe("resolveCommandArgv", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = [...originalArgv];
    delete process.env.ZAPS_COMMAND;
  });

  it("returns the env command with no args when ZAPS_COMMAND is set", () => {
    process.env.ZAPS_COMMAND = "my-zaps";
    expect(resolveCommandArgv()).toEqual({ file: "my-zaps", args: [] });
  });

  it("returns the execPath basename with no args for the native binary", () => {
    process.argv[1] = "/$bunfs/root/main.js";
    const { file, args } = resolveCommandArgv();
    expect(args).toEqual([]);
    expect(file).toBe(path.basename(process.execPath));
  });

  it("splits argv[0] (runtime) and argv[1] (script) for source mode", () => {
    process.argv = ["/usr/bin/node", "/path/to/cli.js", "up"];
    expect(resolveCommandArgv()).toEqual({ file: "/usr/bin/node", args: ["/path/to/cli.js"] });
  });
});

describe("resolveRuntime", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = [...originalArgv];
    delete process.env.ZAPS_RUNTIME;
  });

  it("returns env value when set", () => {
    process.env.ZAPS_RUNTIME = "custom";
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

describe("resolveSessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns configPath and id when config found", async () => {
    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");

    const result = resolveSessionId();
    expect(result.configPath).toBe("/my/.zaps.mts");
    expect(result.id).toBe("session-/my/.zaps.mts");
  });

  it("throws CliError when no config found", async () => {
    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue(null);

    expect(() => resolveSessionId()).toThrow(CliError);
    expect(() => resolveSessionId()).toThrow(/No .zaps.mts config found/);
  });
});

describe("withDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TMUX;
  });

  it("throws the accurate daemon-not-running error when no daemon and no sessionArg", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(false);

    await expect(withDaemon(async () => "result")).rejects.toThrow(DAEMON_NOT_RUNNING);
  });

  it("throws the accurate daemon-not-running error when no daemon and sessionArg provided", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(false);

    await expect(withDaemon(async () => "result", "sess")).rejects.toThrow(DAEMON_NOT_RUNNING);
  });

  it("resolves session from daemon with sessionArg", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(true);

    const { ipcRequest } = await import("../../src/lib/ipc/client.js");
    vi.mocked(ipcRequest).mockResolvedValue({
      id: "r1",
      result: [{ id: "abc123", name: "project-a", projectDir: "/a" }],
    });

    const result = await withDaemon(async (ipc) => {
      expect(ipc.sessionId).toBe("abc123");
      return "daemon-result";
    }, "abc123");
    expect(result).toBe("daemon-result");
  });

  it("throws when daemon session.list returns error", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(true);

    const { ipcRequest } = await import("../../src/lib/ipc/client.js");
    vi.mocked(ipcRequest).mockResolvedValue({ id: "r1", error: "daemon error" });

    await expect(withDaemon(async () => "result", "sess")).rejects.toThrow(/daemon error/);
  });

  it("resolves session by config when no sessionArg", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(true);

    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");

    const { ipcRequest } = await import("../../src/lib/ipc/client.js");
    vi.mocked(ipcRequest).mockResolvedValue({
      id: "r1",
      result: [{ id: "session-/my/.zaps.mts", name: "my-project", projectDir: "/my" }],
    });

    const result = await withDaemon(async (ipc) => {
      expect(ipc.sessionId).toBe("session-/my/.zaps.mts");
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("throws when session not found in daemon session list", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(true);

    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");

    const { ipcRequest } = await import("../../src/lib/ipc/client.js");
    vi.mocked(ipcRequest).mockResolvedValue({
      id: "r1",
      result: [{ id: "other-session", name: "other", projectDir: "/other" }],
    });

    await expect(withDaemon(async () => "result")).rejects.toThrow(
      /No running zaps session for this project/,
    );
  });

  it("throws when session.list returns error without sessionArg", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(true);

    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");

    const { ipcRequest } = await import("../../src/lib/ipc/client.js");
    vi.mocked(ipcRequest).mockResolvedValue({ id: "r1", error: "list error" });

    await expect(withDaemon(async () => "result")).rejects.toThrow(/list error/);
  });
});

describe("runDown", () => {
  const sessions = [{ id: "abc", name: "proj", projectDir: "/proj" }];

  function makeDeps(over: Partial<DownDeps> = {}): {
    deps: DownDeps;
    out: string[];
    err: string[];
    destroy: ReturnType<typeof vi.fn>;
  } {
    const out: string[] = [];
    const err: string[] = [];
    const destroy = vi.fn(over.destroy ?? (async () => ({ id: "d1" })));
    const deps: DownDeps = {
      daemonRunning: over.daemonRunning ?? (() => true),
      socket: over.socket ?? (() => "/tmp/sock"),
      sessionArg: over.sessionArg,
      listSessions: over.listSessions ?? (async () => ({ id: "l1", result: sessions })),
      destroy,
      resolveProjectSessionId: over.resolveProjectSessionId ?? (() => "abc"),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
    return { deps, out, err, destroy };
  }

  it("returns 1 with the accurate error when the daemon is not running", async () => {
    const { deps, err } = makeDeps({ daemonRunning: () => false });
    expect(await runDown(deps)).toBe(1);
    expect(err.join("")).toContain(DAEMON_NOT_RUNNING);
  });

  it("returns 1 when session.list errors", async () => {
    const { deps, err } = makeDeps({ listSessions: async () => ({ id: "l1", error: "boom" }) });
    expect(await runDown(deps)).toBe(1);
    expect(err.join("")).toContain("boom");
  });

  it("returns 1 when nothing matches the current project (nothing to stop)", async () => {
    const { deps, err, destroy } = makeDeps({ resolveProjectSessionId: () => "nope" });
    expect(await runDown(deps)).toBe(1);
    expect(err.join("")).toContain("No running zaps session");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("returns 1 when an explicit session arg cannot be resolved", async () => {
    const { deps, err, destroy } = makeDeps({ sessionArg: "ghost" });
    expect(await runDown(deps)).toBe(1);
    expect(err.join("")).toContain("Session not found");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("returns 1 when destroy fails", async () => {
    const { deps, err } = makeDeps({ destroy: async () => ({ id: "d1", error: "no" }) });
    expect(await runDown(deps)).toBe(1);
    expect(err.join("")).toContain("no");
  });

  it("returns 0 and reports success when the project session is destroyed", async () => {
    const { deps, out, destroy } = makeDeps();
    expect(await runDown(deps)).toBe(0);
    expect(out.join("")).toContain("Session destroyed.");
    expect(destroy).toHaveBeenCalledWith("/tmp/sock", "abc");
  });

  it("returns 0 when a session resolved by arg is destroyed", async () => {
    const { deps, destroy } = makeDeps({ sessionArg: "proj" });
    expect(await runDown(deps)).toBe(0);
    expect(destroy).toHaveBeenCalledWith("/tmp/sock", "abc");
  });
});

describe("parsePositiveInt", () => {
  it("rejects a non-numeric string", () => {
    expect(parsePositiveInt("abc")).toBeNull();
  });

  it("rejects zero", () => {
    expect(parsePositiveInt("0")).toBeNull();
  });

  it("rejects a negative integer", () => {
    expect(parsePositiveInt("-5")).toBeNull();
  });

  it("rejects a non-integer (would silently floor under parseInt)", () => {
    expect(parsePositiveInt("1.5")).toBeNull();
  });

  it("accepts a positive integer", () => {
    expect(parsePositiveInt("10")).toBe(10);
  });
});

describe("resolveTargetSession — subdirectory resolution (E12)", () => {
  const sessions: SessionInfo[] = [
    { id: "a1", name: "app", projectDir: "/home/u/app" },
    { id: "b1", name: "other", projectDir: "/home/u/other" },
  ];

  function withCwd(cwd: string, fn: () => void) {
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
  }

  it("matches a session when cwd is a subdirectory of its projectDir", () => {
    withCwd("/home/u/app/src/components", () => {
      expect(resolveTargetSession(sessions).id).toBe("a1");
    });
  });

  it("does not match a sibling dir sharing a name prefix (/app vs /app2)", () => {
    const siblings: SessionInfo[] = [
      { id: "a1", name: "app", projectDir: "/home/u/app" },
      { id: "c1", name: "other", projectDir: "/home/u/zzz" },
    ];
    withCwd("/home/u/app2", () => {
      expect(() => resolveTargetSession(siblings)).toThrow(/Multiple sessions/);
    });
  });

  it("prefers the deepest (longest) projectDir for nested projects", () => {
    const nested: SessionInfo[] = [
      { id: "root", name: "monorepo", projectDir: "/home/u/app" },
      { id: "pkg", name: "api", projectDir: "/home/u/app/packages/api" },
    ];
    withCwd("/home/u/app/packages/api/src", () => {
      expect(resolveTargetSession(nested).id).toBe("pkg");
    });
  });

  it("exact projectDir match still wins", () => {
    withCwd("/home/u/app", () => {
      expect(resolveTargetSession(sessions).id).toBe("a1");
    });
  });
});

describe("resolveListedSessionId (E8 events validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the id when the project's session is in the list", async () => {
    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");
    const sessions: SessionInfo[] = [
      { id: "session-/my/.zaps.mts", name: "my", projectDir: "/my" },
    ];
    expect(resolveListedSessionId(sessions)).toBe("session-/my/.zaps.mts");
  });

  it("throws when the project's session is not running", async () => {
    const { discoverConfig } = await import("../../src/config/discovery.js");
    vi.mocked(discoverConfig).mockReturnValue("/my/.zaps.mts");
    expect(() => resolveListedSessionId([])).toThrow(/No running zaps session/);
  });

  it("defers to resolveTargetSession for an explicit arg", () => {
    const sessions: SessionInfo[] = [{ id: "abc", name: "proj", projectDir: "/p" }];
    expect(resolveListedSessionId(sessions, "proj")).toBe("abc");
  });

  it("throws for an explicit arg that matches nothing", () => {
    const sessions: SessionInfo[] = [{ id: "abc", name: "proj", projectDir: "/p" }];
    expect(() => resolveListedSessionId(sessions, "ghost")).toThrow(/Session not found/);
  });
});
