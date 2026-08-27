import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

import { decideTmuxContext } from "../../src/cli/tmux-context.js";
import { tmuxAvailable } from "../../src/lib/managed-tmux.js";
import { tmuxFor } from "../../src/lib/tmux.js";

const mockSpawn = vi.mocked(spawn);

/**
 * A spawn that fails the way a missing binary does: no `close`, just an `error`
 * event. Node kills the process over an unhandled one, which is exactly how the
 * "tmux not installed" path used to crash instead of printing its message.
 */
function createEnoentProc(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  setTimeout(() => {
    const error = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    proc.emit("error", error);
  }, 0);
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => createEnoentProc());
});

describe("tmux binary missing", () => {
  it("rejects the command instead of crashing the process", async () => {
    await expect(tmuxFor("zaps").currentPaneId()).rejects.toThrow("ENOENT");
  });

  it("rejects display-popup too (it spawns without a pipe)", async () => {
    await expect(tmuxFor("zaps").displayPopup({ command: "echo hi" })).rejects.toThrow("ENOENT");
  });

  it("lets callers that swallow tmux errors keep working", async () => {
    await expect(tmuxFor("zaps").hasSession("whatever")).resolves.toBe(false);
    await expect(tmuxFor("zaps").tmuxVersion()).resolves.toBeNull();
  });

  it("reports the tmux gate as 'missing' rather than throwing (F8)", async () => {
    await expect(tmuxAvailable(tmuxFor("zaps"))).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("ends in the friendly install message, not a stack trace (F8)", async () => {
    // The whole user-visible chain: no tmux on PATH → gate → decision → text.
    const availability = await tmuxAvailable(tmuxFor("zaps"));
    const decision = decideTmuxContext({
      tmuxEnv: undefined,
      autoTmuxEnv: undefined,
      detach: false,
      tmuxAvailability: availability,
      daemonSession: undefined,
      currentTmuxSession: undefined,
      managedName: "zaps-app-abc123abc123",
      managedSessionExists: false,
    });
    expect(decision.kind).toBe("error-no-tmux");
    const { message } = decision as { message: string };
    expect(message).toContain("zaps requires tmux (>= 3.5) — install it and re-run.");
    expect(message).toContain("https://github.com/tmux/tmux/wiki/Installing");
    expect(message).not.toContain("ENOENT");
  });
});
