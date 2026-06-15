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

vi.mock("../../src/lib/tmux.js", () => ({
  currentSession: vi.fn(),
  showEnv: vi.fn(),
}));

import type { SessionInfo } from "../../src/cli/helpers.js";
import {
  CliError,
  formatTable,
  resolveCommand,
  resolveCommandArgv,
  resolveRuntime,
  resolveSessionId,
  resolveTargetSession,
  withDaemon,
  withLegacyIpc,
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

describe("withLegacyIpc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TMUX;
  });

  it("throws when not in tmux", async () => {
    await expect(withLegacyIpc(async () => "result")).rejects.toThrow(/tmux session/);
  });

  it("throws when no ZAPS_IPC_SOCKET found", async () => {
    process.env.TMUX = "yes";

    const { currentSession, showEnv } = await import("../../src/lib/tmux.js");
    vi.mocked(currentSession).mockResolvedValue("main");
    vi.mocked(showEnv).mockResolvedValue("");

    await expect(withLegacyIpc(async () => "result")).rejects.toThrow(/No running zaps instance/);
  });

  it("calls fn with ipc when socket found", async () => {
    process.env.TMUX = "yes";

    const { currentSession, showEnv } = await import("../../src/lib/tmux.js");
    vi.mocked(currentSession).mockResolvedValue("main");
    vi.mocked(showEnv).mockResolvedValue("/tmp/legacy.sock");

    const result = await withLegacyIpc(async (ipc) => {
      expect(ipc.sessionId).toBe("");
      return "done";
    });
    expect(result).toBe("done");
  });
});

describe("withDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TMUX;
  });

  it("falls back to legacy when no daemon running and no sessionArg", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(false);

    process.env.TMUX = "yes";

    const { currentSession, showEnv } = await import("../../src/lib/tmux.js");
    vi.mocked(currentSession).mockResolvedValue("main");
    vi.mocked(showEnv).mockResolvedValue("/tmp/legacy.sock");

    const result = await withDaemon(async () => "legacy-result");
    expect(result).toBe("legacy-result");
  });

  it("throws when no daemon and sessionArg provided", async () => {
    const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(isDaemonRunning).mockReturnValue(false);

    await expect(withDaemon(async () => "result", "sess")).rejects.toThrow(
      /No running daemon found/,
    );
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
