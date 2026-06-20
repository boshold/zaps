import { describe, expect, it } from "vitest";

import { buildWrapperCommand, joinTaskCommands } from "../../../src/lib/task/run-in-pane.js";

describe("run-in-pane", () => {
  describe("joinTaskCommands", () => {
    it("joins resolved commands with && so a failure short-circuits the rest", () => {
      expect(joinTaskCommands(["echo a", "echo b"])).toBe("echo a && echo b");
    });

    it("returns a single command unchanged", () => {
      expect(joinTaskCommands(["npm run build"])).toBe("npm run build");
    });

    it("returns an empty string for no commands", () => {
      expect(joinTaskCommands([])).toBe("");
    });
  });

  describe("buildWrapperCommand", () => {
    it("invokes the hidden exec-task wrapper for the run, scoped to the session", () => {
      const cmd = buildWrapperCommand({
        zapsCommand: "zaps",
        sessionId: "abc123",
        runId: "run_42",
      });
      expect(cmd).toBe("zaps -s abc123 exec-task run_42");
    });

    it("honors a custom zaps command path", () => {
      const cmd = buildWrapperCommand({
        zapsCommand: "/opt/zaps/bin/zaps",
        sessionId: "s1",
        runId: "run_1",
      });
      expect(cmd).toBe("/opt/zaps/bin/zaps -s s1 exec-task run_1");
    });
  });
});
