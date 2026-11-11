import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
  inner: { outcome?: { exitCode: number; message?: string } };
  recordOutcome(): void;
}

/**
 * Bootstrap wired to fakes: tmux never runs, so every path (create, respawn,
 * settle, kill) is observable as an argv list.
 */
function harness(overrides: Partial<BootstrapDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const tmuxCalls: string[][] = [];
  let resultPath: string | undefined = undefined;
  const inner: Harness["inner"] = { outcome: { exitCode: 0 } };
  function recordOutcome(): void {
    if (resultPath && inner.outcome) {
      fs.writeFileSync(resultPath, JSON.stringify(inner.outcome));
    }
  }
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
      if (args[2] === "respawn-pane") {
        recordOutcome();
      }
      return 0;
    }),
    createTmux: vi.fn(async (args: string[]) => {
      tmuxCalls.push(args);
      const snapshot = args.find((arg) => arg.startsWith("ZAPS_ENVIRONMENT_SNAPSHOT="));
      if (snapshot) {
        resultPath = path.join(
          path.dirname(snapshot.slice("ZAPS_ENVIRONMENT_SNAPSHOT=".length)),
          "result.json",
        );
      }
      return "$3|%3|42";
    }),
    startTmuxClient: vi.fn((args: string[]) => {
      tmuxCalls.push(args);
      recordOutcome();
      return { result: Promise.resolve(0), close: vi.fn() };
    }),
    daemonSession: vi.fn().mockResolvedValue(undefined),
    currentTmuxSession: vi.fn().mockResolvedValue(undefined),
    zapsArgv: () => ["/usr/bin/zaps"],
    size: () => ({ width: 200, height: 50 }),
    settleTimeoutMs: 200,
    ...overrides,
  };
  return { deps, out, err, tmuxCalls, inner, recordOutcome };
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

describe("ensureTmuxContext — managed creation", () => {
  it("configures the new host, then queues foreground attach before inner startup", async () => {
    const h = harness();
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 0 });

    expect(h.tmuxCalls.map((args) => args[2])).toEqual([
      "new-session",
      "set-option",
      "set-option",
      "attach-session",
    ]);
    expect(callFor(h, "new-session")).toContain("-d");
    expect(h.tmuxCalls[1]).toEqual([
      "-L",
      "zaps",
      "set-option",
      "-t",
      "$3:",
      "destroy-unattached",
      "off",
    ]);
    expect(h.tmuxCalls[2]).toEqual([
      "-L",
      "zaps",
      "set-option",
      "-p",
      "-t",
      "%3",
      "remain-on-exit",
      "on",
    ]);
    expect(callFor(h, "attach-session")).toEqual([
      "-L",
      "zaps",
      "attach-session",
      "-t",
      "$3",
      ";",
      "respawn-pane",
      "-k",
      "-t",
      "%3",
      "--",
      "/usr/bin/zaps",
      "--managed-bootstrap",
      "up",
      "-B",
      "tmux",
    ]);
  });

  it("uses the actual client exit code after the inner UI is ready", async () => {
    const h = harness();
    h.deps.startTmuxClient = vi.fn(() => {
      h.recordOutcome();
      return { result: Promise.resolve(7), close: vi.fn() };
    });
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 7 });
    expect(callFor(h, "if-shell")).toBeUndefined();
  });

  it("returns a foreground conflict without waiting for the attached client", async () => {
    const h = harness();
    h.inner.outcome = { exitCode: 1, message: "backend_conflict: shell won" };
    let close: () => void = () => undefined;
    const result = new Promise<number>((resolve) => {
      close = () => resolve(0);
    });
    const stop = vi.fn(close);
    h.deps.startTmuxClient = vi.fn(() => {
      h.recordOutcome();
      return { result, close: stop };
    });
    await expect(run(h)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("backend_conflict: shell won");
    expect(h.out).toEqual([]);
    expect(callFor(h, "if-shell")).toEqual([
      "-L",
      "zaps",
      "if-shell",
      "-F",
      "-t",
      "$3",
      "#{==:#{pid},42}",
      "kill-session -t '$3'",
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses the recorded detached result when the dead pane status is unreadable", async () => {
    const h = harness();
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1|");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 0 });
    expect(h.out.join("")).toContain("started (detached, managed tmux)");
    expect(callFor(h, "respawn-pane")?.at(-1)).toBe("-d");
  });

  it("does not turn registered hook failure or unreadable status into success", async () => {
    const h = harness();
    h.inner.outcome = { exitCode: 1, message: "startup hook failed" };
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1|");
    h.deps.daemonSession = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => ({
        name: "app",
        tmuxSession:
          callFor(h, "new-session")?.find((arg) => arg.startsWith("zaps-zaps-bootstrap-test-")) ??
          "",
        managed: true,
        tuiPane: "%3",
      }));
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("startup hook failed");
    expect(h.out).toEqual([]);
    expect(callFor(h, "if-shell")).toBeUndefined();
  });

  it("preserves a registered host but fails when its dead pane has no status or handoff", async () => {
    const h = harness();
    h.inner.outcome = undefined;
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1|");
    h.deps.daemonSession = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => ({
        name: "app",
        tmuxSession:
          callFor(h, "new-session")?.find((arg) => arg.startsWith("zaps-zaps-bootstrap-test-")) ??
          "",
        managed: true,
        tuiPane: "%3",
      }));
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("died before reporting a result");
    expect(h.out).toEqual([]);
    expect(callFor(h, "if-shell")).toBeUndefined();
  });

  it("forwards routing variables and removes the private handoff after completion", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-bootstrap-runtime-"));
    vi.stubEnv("XDG_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("ZAPS_SOCKET_PATH", "/tmp/custom.sock");
    const h = harness();
    const create = h.deps.createTmux;
    let forwarded: Record<string, string> = {};
    let snapshot: string | undefined;
    h.deps.createTmux = vi.fn(async (args: string[]) => {
      const entry = args.find((arg) => arg.startsWith("ZAPS_ENVIRONMENT_SNAPSHOT="));
      snapshot = entry?.slice("ZAPS_ENVIRONMENT_SNAPSHOT=".length);
      if (snapshot) {
        forwarded = z
          .record(z.string(), z.string())
          .parse(JSON.parse(fs.readFileSync(snapshot, "utf8")));
      }
      expect(args).toContain(`XDG_RUNTIME_DIR=${runtimeDir}`);
      expect(args).toContain("ZAPS_SOCKET_PATH=/tmp/custom.sock");
      return create(args);
    });
    try {
      await run(h, true);
      expect(forwarded).toMatchObject({
        XDG_RUNTIME_DIR: runtimeDir,
        ZAPS_SOCKET_PATH: "/tmp/custom.sock",
      });
      expect(snapshot && fs.existsSync(path.dirname(snapshot))).toBe(false);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("replays pane output and propagates a known failure without a result", async () => {
    const h = harness();
    h.inner.outcome = undefined;
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("1|3");
    h.deps.tmux.capturePane = vi.fn().mockResolvedValue("Error: bad config\n\n");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 3 });
    expect(h.err.join("")).toContain("Error: bad config");
    expect(callFor(h, "if-shell")).toBeDefined();
  });

  it("reports timeout and cleans up only the provisioned host", async () => {
    const h = harness();
    h.inner.outcome = undefined;
    h.deps.tmux.displayMessage = vi.fn().mockResolvedValue("0|");
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Timed out waiting for");
    expect(callFor(h, "if-shell")).toBeDefined();
  });

  it("reports failure for a vanished pane with no result", async () => {
    const h = harness();
    h.inner.outcome = undefined;
    h.deps.tmux.displayMessage = vi.fn().mockRejectedValue(new Error("can't find pane"));
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("died before reporting a result");
  });

  it("does not attempt cleanup when creation never returned an owned host", async () => {
    const h = harness();
    h.deps.createTmux = vi.fn().mockRejectedValue(new Error("session already exists"));
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Failed to create managed tmux session");
    expect(h.tmuxCalls).toHaveLength(0);
  });

  it("cleans up when the pane cannot be respawned with zaps", async () => {
    const h = harness();
    h.deps.runTmux = vi.fn(async (args: string[]) => {
      h.tmuxCalls.push(args);
      return args[2] === "respawn-pane" ? 1 : 0;
    });
    await expect(run(h, true)).resolves.toEqual({ proceed: false, exitCode: 1 });
    expect(h.err.join("")).toContain("Failed to start zaps in managed tmux session");
    expect(callFor(h, "if-shell")).toBeDefined();
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
