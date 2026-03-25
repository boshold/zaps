import { describe, expect, it } from "vitest";

import { wrapCommand } from "../../src/cli/exec-service.js";

describe("wrapCommand", () => {
  it("prefixes simple commands with exec", () => {
    expect(wrapCommand("pnpm dev")).toBe("exec pnpm dev");
  });

  it("prefixes single-word commands", () => {
    expect(wrapCommand("node")).toBe("exec node");
  });

  it("prefixes commands with arguments", () => {
    expect(wrapCommand("node index.js --port 3000")).toBe("exec node index.js --port 3000");
  });

  it("does not prefix pipe commands", () => {
    expect(wrapCommand("cmd1 | cmd2")).toBe("cmd1 | cmd2");
  });

  it("does not prefix && chains", () => {
    expect(wrapCommand("cmd1 && cmd2")).toBe("cmd1 && cmd2");
  });

  it("does not prefix || chains", () => {
    expect(wrapCommand("cmd1 || cmd2")).toBe("cmd1 || cmd2");
  });

  it("does not prefix semicolon chains", () => {
    expect(wrapCommand("cmd1; cmd2")).toBe("cmd1; cmd2");
  });

  it("does not prefix backtick commands", () => {
    expect(wrapCommand("echo `date`")).toBe("echo `date`");
  });

  it("does not prefix subshell commands", () => {
    expect(wrapCommand("(cd /tmp && ls)")).toBe("(cd /tmp && ls)");
  });

  it("does not prefix background commands", () => {
    expect(wrapCommand("cmd &")).toBe("cmd &");
  });
});
