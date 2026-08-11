import { describe, expect, it } from "vitest";

import {
  LEGACY_TMUX_ERROR,
  TMUX_INSTALL_URL,
  decideTmuxContext,
} from "../../src/cli/tmux-context.js";
import type { DaemonSessionView, TmuxContextInput } from "../../src/cli/tmux-context.js";

const MANAGED_NAME = "zaps-app-a1b2c3d4e5f6";

/** Plain terminal, tmux fine, nothing running — the F1 baseline. */
function input(overrides: Partial<TmuxContextInput> = {}): TmuxContextInput {
  return {
    tmuxEnv: undefined,
    autoTmuxEnv: undefined,
    detach: false,
    tmuxAvailability: { ok: true, version: "3.5" },
    daemonSession: undefined,
    currentTmuxSession: undefined,
    managedName: MANAGED_NAME,
    managedSessionExists: false,
    ...overrides,
  };
}

const managedSession: DaemonSessionView = {
  name: "app",
  tmuxSession: MANAGED_NAME,
  managed: true,
  tuiPane: "%3",
};

const personalSession: DaemonSessionView = {
  name: "app",
  tmuxSession: "work",
  managed: false,
  tuiPane: "%1",
};

describe("decideTmuxContext — inside tmux", () => {
  it("proceeds with today's flow, unchanged", () => {
    expect(decideTmuxContext(input({ tmuxEnv: "/tmp/tmux-1000/default,123,0" }))).toEqual({
      kind: "proceed-inside",
    });
  });

  it("proceeds even when a personal session is already running", () => {
    const decision = decideTmuxContext(
      input({ tmuxEnv: "/tmp/tmux-1000/default,123,0", daemonSession: personalSession }),
    );
    expect(decision).toEqual({ kind: "proceed-inside" });
  });

  it("wins over the escape hatch and a broken tmux binary (both are irrelevant inside)", () => {
    const decision = decideTmuxContext(
      input({
        tmuxEnv: "/tmp/tmux-1000/default,123,0",
        autoTmuxEnv: "0",
        tmuxAvailability: { ok: false, reason: "missing" },
      }),
    );
    expect(decision).toEqual({ kind: "proceed-inside" });
  });

  it("carries on inside the project's OWN managed session (post-detach shell)", () => {
    // The tmux-naive user quit the TUI and typed `zaps` at the pane's shell:
    // Refusing here would be a dead end — the TUI just attaches in this pane.
    const decision = decideTmuxContext(
      input({
        tmuxEnv: "/tmp/tmux-1000/zaps,123,0",
        daemonSession: managedSession,
        currentTmuxSession: MANAGED_NAME,
      }),
    );
    expect(decision).toEqual({ kind: "proceed-inside" });
  });

  it("refuses when the session is managed by a tmux we are NOT in (F7)", () => {
    const decision = decideTmuxContext(
      input({
        tmuxEnv: "/tmp/tmux-1000/default,123,0",
        daemonSession: managedSession,
        currentTmuxSession: "work",
      }),
    );
    expect(decision.kind).toBe("refuse-managed");
    expect(decision).toMatchObject({
      message: expect.stringContaining("zaps-managed tmux") as unknown as string,
    });
  });
});

describe("decideTmuxContext — escape hatch and tmux gate", () => {
  it("restores the legacy error for ZAPS_AUTO_TMUX=0", () => {
    expect(decideTmuxContext(input({ autoTmuxEnv: "0" }))).toEqual({
      kind: "error-legacy",
      message: LEGACY_TMUX_ERROR,
    });
  });

  it("only honors an exact '0' opt-out", () => {
    expect(decideTmuxContext(input({ autoTmuxEnv: "1" })).kind).toBe("spawn");
    expect(decideTmuxContext(input({ autoTmuxEnv: "" })).kind).toBe("spawn");
  });

  it("takes the escape hatch before probing tmux", () => {
    const decision = decideTmuxContext(
      input({ autoTmuxEnv: "0", tmuxAvailability: { ok: false, reason: "missing" } }),
    );
    expect(decision.kind).toBe("error-legacy");
  });

  it("reports missing tmux with the install link (F8)", () => {
    const decision = decideTmuxContext(
      input({ tmuxAvailability: { ok: false, reason: "missing" } }),
    );
    expect(decision.kind).toBe("error-no-tmux");
    const { message } = decision as { message: string };
    expect(message).toContain("zaps requires tmux (>= 3.5a)");
    expect(message).toContain(TMUX_INSTALL_URL);
    expect(message).not.toContain("Found tmux");
  });

  it("names the version it found when tmux is too old (F8)", () => {
    const decision = decideTmuxContext(
      input({ tmuxAvailability: { ok: false, reason: "too-old", version: "3.2" } }),
    );
    expect(decision.kind).toBe("error-no-tmux");
    const { message } = decision as { message: string };
    // The requirement is quoted verbatim from the spec, never the parsed label.
    expect(message).toContain(">= 3.5a");
    expect(message).toContain("Found tmux 3.2.");
  });

  it("gates on tmux before touching any session state", () => {
    const decision = decideTmuxContext(
      input({
        tmuxAvailability: { ok: false, reason: "missing" },
        daemonSession: managedSession,
        managedSessionExists: true,
      }),
    );
    expect(decision.kind).toBe("error-no-tmux");
  });
});

describe("decideTmuxContext — running sessions", () => {
  it("re-attaches to this project's managed session, carrying its TUI pane (F3)", () => {
    expect(decideTmuxContext(input({ daemonSession: managedSession }))).toEqual({
      kind: "reattach",
      name: MANAGED_NAME,
      tuiPane: "%3",
    });
  });

  it("reports instead of re-creating when `up -d` finds it already running", () => {
    const decision = decideTmuxContext(input({ daemonSession: managedSession, detach: true }));
    expect(decision.kind).toBe("already-running");
    expect(decision).toMatchObject({
      message: expect.stringContaining("already running") as unknown as string,
    });
  });

  it("refuses a session living in the user's own tmux (F6)", () => {
    const decision = decideTmuxContext(input({ daemonSession: personalSession }));
    expect(decision.kind).toBe("refuse-personal");
    const { message } = decision as { message: string };
    expect(message).toContain(`Session "app" is running inside tmux session 'work'`);
    expect(message).toContain("zaps down");
  });

  it("refuses the personal session even with -d (never spawns a second one)", () => {
    expect(decideTmuxContext(input({ daemonSession: personalSession, detach: true })).kind).toBe(
      "refuse-personal",
    );
  });

  it("prefers the daemon's answer over a same-named tmux session", () => {
    // Not stale: the daemon still owns it, so the name must not be reaped.
    const decision = decideTmuxContext(
      input({ daemonSession: managedSession, managedSessionExists: true }),
    );
    expect(decision.kind).toBe("reattach");
  });
});

describe("decideTmuxContext — stale sessions (F9)", () => {
  it("reaps a managed session the daemon knows nothing about, then creates", () => {
    expect(decideTmuxContext(input({ managedSessionExists: true }))).toEqual({
      kind: "kill-stale-then-spawn",
      name: MANAGED_NAME,
      detach: false,
    });
  });

  it("carries the detach flag through the stale path", () => {
    expect(decideTmuxContext(input({ managedSessionExists: true, detach: true }))).toEqual({
      kind: "kill-stale-then-spawn",
      name: MANAGED_NAME,
      detach: true,
    });
  });
});

describe("decideTmuxContext — create paths", () => {
  it("spawns and attaches for plain `zaps` / `zaps up` (F1)", () => {
    expect(decideTmuxContext(input())).toEqual({ kind: "spawn", name: MANAGED_NAME });
  });

  it("spawns detached for `zaps up -d` (F4)", () => {
    expect(decideTmuxContext(input({ detach: true }))).toEqual({
      kind: "spawn-detached",
      name: MANAGED_NAME,
    });
  });
});
