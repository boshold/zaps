import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const waitForChannel = vi.fn<(channel: string) => Promise<void>>();
const signalChannel = vi.fn<(channel: string) => Promise<void>>();

vi.mock("../../../src/lib/tmux.js", () => ({
  waitForChannel: async (channel: string) => waitForChannel(channel),
  signalChannel: async (channel: string) => signalChannel(channel),
}));

const { awaitPaneOutcome, buildPaneCommand, buildPaneScript, paneChannels } =
  await import("../../../src/lib/task/run-in-pane.js");

describe("run-in-pane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("paneChannels", () => {
    it("namespaces ok/err channels by runId", () => {
      const { ok, err } = paneChannels("run_42");
      expect(ok).toBe("zaps_done_ok_run_42");
      expect(err).toBe("zaps_done_err_run_42");
      // Distinct runs never share a channel.
      expect(paneChannels("run_99").ok).not.toBe(ok);
    });
  });

  describe("buildPaneScript", () => {
    it("cds into cwd, joins commands with &&, and signals the ok channel on success", () => {
      const script = buildPaneScript(["echo a", "echo b"], {
        cwd: "/proj",
        env: {},
        runId: "run_1",
      });
      expect(script).toContain("cd '/proj' &&");
      expect(script).toContain("echo a && echo b");
      expect(script).toContain("tmux wait-for -S zaps_done_ok_run_1");
      expect(script).toContain("tmux wait-for -S zaps_done_err_run_1");
      // Outcome is branched on the captured exit code.
      expect(script).toContain('if [ "$__zrc" -eq 0 ]');
    });

    it("exports env inside the subshell so it never leaks into the pane shell", () => {
      const script = buildPaneScript(["run"], {
        cwd: "/proj",
        env: { TOKEN: "s e c", NODE_ENV: "test" },
        runId: "run_2",
      });
      expect(script).toContain("export TOKEN='s e c';");
      expect(script).toContain("export NODE_ENV='test';");
      // Exports live inside the parenthesised subshell, before the command body.
      expect(script).toMatch(/\( export TOKEN='s e c'; export NODE_ENV='test'; run \)/u);
    });

    it("shell-escapes a cwd containing single quotes", () => {
      const script = buildPaneScript(["run"], {
        cwd: "/weird/it's here",
        env: {},
        runId: "run_3",
      });
      expect(script).toContain(String.raw`cd '/weird/it'\''s here' &&`);
    });
  });

  describe("buildPaneCommand", () => {
    it("wraps the script in `sh -c` so it runs regardless of the pane's shell", () => {
      const script = buildPaneScript(["echo a"], { cwd: "/proj", env: {}, runId: "run_4" });
      const cmd = buildPaneCommand(["echo a"], { cwd: "/proj", env: {}, runId: "run_4" });
      expect(cmd.startsWith("sh -c '")).toBe(true);
      // Channel names carry no quotes, so they survive the single-quote wrap verbatim.
      expect(cmd).toContain("zaps_done_ok_run_4");
      // The inner POSIX (with single quotes escaped as '\'') round-trips exactly.
      expect(cmd).toBe(`sh -c '${script.replaceAll("'", String.raw`'\''`)}'`);
    });
  });

  describe("awaitPaneOutcome", () => {
    it("returns success when the ok channel fires first and releases the err waiter", async () => {
      waitForChannel.mockImplementation(async (channel: string) => {
        if (channel === "zaps_done_ok_run_x") {
          return;
        }
        // The err waiter blocks until released.
        await new Promise<void>(() => {
          /* Never resolves on its own */
        });
      });
      signalChannel.mockResolvedValue(undefined);

      const result = await awaitPaneOutcome("run_x");
      expect(result).toBe("success");
      // The losing (err) waiter is released so its tmux client exits.
      expect(signalChannel).toHaveBeenCalledWith("zaps_done_err_run_x");
    });

    it("returns error when the err channel fires first and releases the ok waiter", async () => {
      waitForChannel.mockImplementation(async (channel: string) => {
        if (channel === "zaps_done_err_run_y") {
          return;
        }
        await new Promise<void>(() => {
          /* Never resolves on its own */
        });
      });
      signalChannel.mockResolvedValue(undefined);

      const result = await awaitPaneOutcome("run_y");
      expect(result).toBe("error");
      expect(signalChannel).toHaveBeenCalledWith("zaps_done_ok_run_y");
    });

    it("swallows a failure to release the losing waiter", async () => {
      waitForChannel.mockImplementation(async (channel: string) => {
        if (channel === "zaps_done_ok_run_z") {
          return;
        }
        await new Promise<void>(() => {
          /* Never resolves */
        });
      });
      signalChannel.mockRejectedValue(new Error("server gone"));

      await expect(awaitPaneOutcome("run_z")).resolves.toBe("success");
    });
  });
});
