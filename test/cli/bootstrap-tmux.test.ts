import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureTmuxContext } from "../../src/cli/bootstrap-tmux.js";
import type { BootstrapDeps } from "../../src/cli/bootstrap-tmux.js";
import type { DaemonSessionView } from "../../src/cli/tmux-context.js";

const CONFIG_PATH = "/tmp/zaps-bootstrap-test/.zaps.mts";
const PROJECT_DIR = "/tmp/zaps-bootstrap-test";

interface Harness {
  deps: BootstrapDeps;
  out: string[];
  err: string[];
  tmuxCalls: string[][];
}

/**
 * Bootstrap wired to fakes: tmux never runs, so every path (create, respawn,
 * settle, kill) is observable as an argv list.
 */
function harness(overrides: Partial<BootstrapDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const tmuxCalls: string[][] = [];
  const deps: BootstrapDeps = {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
    tmux: {
      capturePane: vi.fn().mockResolvedValue(""),
      // Dead pane, exit 0 — the happy `up -d` settlement.
      displayMessage: vi.fn().mockResolvedValue("1|0|"),
      hasSession: vi.fn().mockResolvedValue(false),
      killSession: vi.fn().mockResolvedValue(undefined),
      listPanes: vi
        .fn()
        .mockResolvedValue([{ id: "%3", pid: 42, width: 80, height: 24, dead: false }]),
      tmuxVersion: vi.fn().mockResolvedValue({ major: 3, minor: 5 }),
    },
    runTmux: vi.fn(async (args: string[]) => {
      tmuxCalls.push(args);
      return 0;
    }),
    daemonSession: vi.fn().mockResolvedValue(undefined),
    currentTmuxSession: vi.fn().mockResolvedValue(undefined),
    zapsArgv: () => ["/usr/bin/zaps"],
    size: () => ({ width: 200, height: 50 }),
    settleTimeoutMs: 200,
    sessionVisibleTimeoutMs: 100,
    ...overrides,
  };
  return { deps, out, err, tmuxCalls };
}

/** `hasSession`: false for the staleness probe, true once the session exists. */
function sessionAppearsAfterCreate(h: Harness): void {
  h.deps.tmux.hasSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
}

async function run(h: Harness, detach = false): Promise<{ exitCode?: number; proceed: boolean }> {
  const result = await ensureTmuxContext({
    configPath: CONFIG_PATH,
    projectDir: PROJECT_DIR,
    detach,
    deps: h.deps,
  });
  return result.proceed ? { proceed: true } : { proceed: false, exitCode: result.exitCode };
}

/** Argv of the first tmux call whose verb matches. */
function callFor(h: Harness, verb: string): string[] | undefined {
  return h.tmuxCalls.find((args) => args[2] === verb);
}

beforeEach(() => {
  vi.stubEnv("TMUX", undefined);
  vi.stubEnv("ZAPS_AUTO_TMUX", undefined);
  vi.stubEnv("ZAPS_SOCKET_PATH", undefined);
  vi.stubEnv("XDG_RUNTIME_DIR", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ensureTmuxContext — inside tmux", () => {
  it("proceeds without running a single tmux command", async () => {
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
    const h = harness();
    await expect(run(h)).resolves.toEqual({ proceed: true });
    expect(h.tmuxCalls).toEqual([]);
    expect(h.deps.tmux.tmuxVersion).not.toHaveBeenCalled();
    expect(h.deps.tmux.hasSession).not.toHaveBeenCalled();
  });
});

describe("ensureTmuxContext — refusals", () => {
  it("prints the legacy error for ZAPS_AUTO_TMUX=0 and exits 1", async () => {
    vi.stubEnv("ZAPS_AUTO_TMUX", "0");
    const h = harness();
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("zaps must be run from inside a tmux session.");
    expect(h.tmuxCalls).toEqual([]);
  });

  it("prints the tmux requirement when tmux is missing", async () => {
    const h = harness();
    h.deps.tmux.tmuxVersion = vi.fn().mockResolvedValue(null);
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("zaps requires tmux (>= 3.5)");
  });

  it("refuses a session running in the user's own tmux", async () => {
    const personal: DaemonSessionView = {
      name: "app",
      tmuxSession: "work",
      managed: false,
      tuiPane: "%3",
    };
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(personal) });
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("running inside tmux session 'work'");
    expect(h.tmuxCalls).toEqual([]);
  });
});

describe("ensureTmuxContext — re-attach", () => {
  const managed: DaemonSessionView = {
    name: "app",
    tmuxSession: "zaps-app-abc",
    managed: true,
    tuiPane: "%3",
  };

  /** Dead-but-held TUI pane: what `remain-on-exit` leaves behind after a detach. */
  function deadTuiPane(h: Harness): void {
    h.deps.tmux.listPanes = vi
      .fn()
      .mockResolvedValue([{ id: "%3", pid: 42, width: 80, height: 24, dead: true }]);
  }

  it("attaches with the TTY handed to tmux and mirrors its exit code", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    // Pane still alive (nothing to revive) — just attach.
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return 130;
    });
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 130 });
    expect(h.tmuxCalls).toEqual([["-L", "zaps", "attach-session", "-t", "=zaps-app-abc"]]);
    expect(vi.mocked(h.deps.runTmux).mock.calls[0][1]).toBe(true);
  });

  it("revives a dead TUI pane in place before attaching (F3)", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    deadTuiPane(h);
    await run(h);
    expect(h.tmuxCalls).toEqual([
      // No `-k`: the pane is dead-but-held, respawning it must not need a kill.
      ["-L", "zaps", "respawn-pane", "-t", "%3", "--", "/usr/bin/zaps", "attach"],
      ["-L", "zaps", "attach-session", "-t", "=zaps-app-abc"],
    ]);
  });

  it("opens a window instead of failing when the TUI pane is gone", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    // The pane is not in the session's pane list at all.
    h.deps.tmux.listPanes = vi
      .fn()
      .mockResolvedValue([{ id: "%9", pid: 1, width: 8, height: 2, dead: false }]);
    await run(h);
    expect(h.tmuxCalls[0]).toEqual([
      "-L",
      "zaps",
      "new-window",
      "-t",
      "=zaps-app-abc",
      "--",
      "/usr/bin/zaps",
      "attach",
    ]);
    expect(h.err.join("")).toContain("opening a new window instead");
  });

  it("falls back to a new window when the respawn itself fails", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    deadTuiPane(h);
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return args[2] === "respawn-pane" ? 1 : 0;
    });
    await run(h);
    expect(h.tmuxCalls.map((args) => args[2])).toEqual([
      "respawn-pane",
      "new-window",
      "attach-session",
    ]);
  });

  it("prints the detach hint when the session outlives the client (F2)", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    deadTuiPane(h);
    h.deps.tmux.hasSession = vi.fn().mockResolvedValue(true);
    await run(h);
    expect(h.out.join("")).toContain(
      "detached — services still running. zaps to re-attach, zaps down to stop.",
    );
  });

  it("stays silent when the session is gone (teardown prints its own summary)", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    deadTuiPane(h);
    h.deps.tmux.hasSession = vi.fn().mockResolvedValue(false);
    await run(h);
    expect(h.out.join("")).toBe("");
  });

  it("reports instead of re-creating when `up -d` finds it running", async () => {
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 0 });
    expect(h.out.join("")).toContain("already running");
    expect(h.tmuxCalls).toEqual([]);
  });
});

describe("ensureTmuxContext — attached create (F1)", () => {
  it("creates the session in the foreground and mirrors tmux's exit code", async () => {
    const h = harness();
    sessionAppearsAfterCreate(h);
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return args[2] === "new-session" ? 7 : 0;
    });
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 7 });

    const create = callFor(h, "new-session");
    expect(create).toBeDefined();
    expect(create?.slice(-3)).toEqual(["--", "/usr/bin/zaps", "up"]);
    expect(create).toContain("ZAPS_MANAGED_TMUX=1");
    expect(create).toContain("ZAPS_TMUX_SOCKET=zaps");
    // Foreground: the child owns the terminal.
    expect(vi.mocked(h.deps.runTmux).mock.calls[0][1]).toBe(true);
  });

  it("applies the managed options once the session shows up", async () => {
    const h = harness();
    sessionAppearsAfterCreate(h);
    await run(h);
    expect(h.tmuxCalls).toContainEqual([
      "-L",
      "zaps",
      "set-option",
      "-t",
      expect.stringMatching(/^=zaps-zaps-bootstrap-test-.*:$/u) as unknown as string,
      "destroy-unattached",
      "off",
    ]);
    expect(h.tmuxCalls).toContainEqual([
      "-L",
      "zaps",
      "set-option",
      "-p",
      "-t",
      "%3",
      "remain-on-exit",
      "on",
    ]);
  });

  it("prints the detach hint after the foreground client exits (F2)", async () => {
    const h = harness();
    sessionAppearsAfterCreate(h);
    await run(h);
    expect(h.out.join("")).toContain("detached — services still running");
  });

  it("still exits with tmux's code when the session never appears", async () => {
    // HasSession stays false: options are skipped, the result is unaffected.
    const h = harness();
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 0 });
  });
});

describe("ensureTmuxContext — detached create (F4)", () => {
  it("creates bare, sets options, then respawns the pane with zaps", async () => {
    const h = harness();
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 0 });

    const verbs = h.tmuxCalls.map((args) => args.slice(2, 3).join(""));
    expect(verbs).toEqual(["new-session", "set-option", "set-option", "respawn-pane"]);

    const create = callFor(h, "new-session");
    // No command: the pane options must land before zaps can exit.
    expect(create).not.toContain("--");
    expect(create).toContain("-d");
    expect(create?.slice(4, 8)).toEqual(["-x", "200", "-y", "50"]);

    const respawn = callFor(h, "respawn-pane");
    expect(respawn).toEqual([
      "-L",
      "zaps",
      "respawn-pane",
      "-k",
      "-t",
      "%3",
      "--",
      "/usr/bin/zaps",
      "up",
      "-d",
    ]);
    expect(h.out.join("")).toContain("started (detached, managed tmux)");
  });

  it("forwards the daemon-locating env into the session", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("ZAPS_SOCKET_PATH", "/tmp/custom.sock");
    const h = harness();
    await run(h, true);
    const create = callFor(h, "new-session");
    expect(create).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    expect(create).toContain("ZAPS_SOCKET_PATH=/tmp/custom.sock");
  });

  it("replays the inner output and propagates the exit code on failure", async () => {
    const h = harness();
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1|3|");
    h.deps.tmux.capturePane = vi.fn().mockResolvedValue("Error: bad config\n\n");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 3 });
    expect(h.err.join("")).toContain("Error: bad config");
    // No orphan session left behind.
    expect(h.deps.tmux.killSession).toHaveBeenCalledWith(
      expect.stringContaining("zaps-zaps-bootstrap-test-"),
    );
  });

  it("kills the session and exits 1 when the inner run never settles", async () => {
    // Pane still alive at the deadline: no exit code to propagate.
    const h = harness();
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("0||");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Timed out waiting for");
    expect(h.deps.tmux.killSession).toHaveBeenCalled();
  });

  it("reports a pane that died without a readable status", async () => {
    const h = harness({ settleTimeoutMs: 5000 });
    h.deps.tmux.displayMessage = vi.fn().mockRejectedValue(new Error("can't find pane"));
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("died before reporting a result");
  });

  it("falls back to the daemon when the dead pane's status never lands", async () => {
    // Reap-lag zombie: pane dead, status unreadable forever — but the daemon
    // Registered the session, which only happens when the inner run succeeded.
    const h = harness({
      settleTimeoutMs: 5000,
      daemonSession: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({
        name: "app",
        tmuxSession: "zaps-app-x",
        managed: true,
        tuiPane: "%3",
      }),
    });
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1||");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 0 });
    expect(h.out.join("")).toContain("started (detached, managed tmux)");
    expect(h.deps.tmux.killSession).not.toHaveBeenCalled();
  });

  it("still fails on an unreadable status when the daemon knows nothing", async () => {
    // Pre-session failures never register a daemon session, so the fallback
    // Cannot mask them.
    const h = harness({ settleTimeoutMs: 5000 });
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1||");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("died before reporting a result");
    expect(h.deps.tmux.killSession).toHaveBeenCalled();
  });

  it("gives up when tmux cannot create the session", async () => {
    const h = harness();
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return args[2] === "new-session" ? 1 : 0;
    });
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Failed to create managed tmux session");
    expect(h.tmuxCalls).toHaveLength(1);
  });

  it("cleans up when the session disappears before the pane can be read", async () => {
    const h = harness();
    h.deps.tmux.listPanes = vi.fn().mockResolvedValue([]);
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("vanished before it could start");
    expect(h.deps.tmux.killSession).toHaveBeenCalled();
  });

  it("cleans up when the pane cannot be respawned with zaps", async () => {
    const h = harness();
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return args[2] === "respawn-pane" ? 1 : 0;
    });
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Failed to start zaps in managed tmux session");
    expect(h.deps.tmux.killSession).toHaveBeenCalled();
  });
});

describe("ensureTmuxContext — stale session (F9)", () => {
  it("kills the leftover session before creating a fresh one", async () => {
    const h = harness();
    h.deps.tmux.hasSession = vi.fn().mockResolvedValue(true);
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 0 });
    expect(h.deps.tmux.killSession).toHaveBeenCalledWith(
      expect.stringContaining("zaps-zaps-bootstrap-test-"),
    );
    expect(h.tmuxCalls[0][2]).toBe("new-session");
  });

  it("never reaps a session the daemon still owns", async () => {
    const managed: DaemonSessionView = {
      name: "app",
      tmuxSession: "zaps-app",
      managed: true,
      tuiPane: "%3",
    };
    const h = harness({ daemonSession: vi.fn().mockResolvedValue(managed) });
    await run(h);
    expect(h.deps.tmux.killSession).not.toHaveBeenCalled();
    // The only `has-session` here is the post-detach probe, which runs AFTER the
    // Client exits — never as a staleness check that could reap a live session.
    expect(h.tmuxCalls.at(-1)?.[2]).toBe("attach-session");
  });
});
