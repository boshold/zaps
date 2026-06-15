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

  it("does not prefix env-assignment-prefixed commands (B1)", () => {
    expect(wrapCommand("NODE_ENV=test npm start")).toBe("NODE_ENV=test npm start");
  });

  it("tolerates leading whitespace before an env assignment", () => {
    expect(wrapCommand("  FOO=1 cmd")).toBe("  FOO=1 cmd");
  });

  it("does not prefix env-prefix combined with metacharacters", () => {
    expect(wrapCommand("FOO=bar a | b")).toBe("FOO=bar a | b");
  });

  it("still prefixes a command with a non-leading = (e.g. --opt=val)", () => {
    expect(wrapCommand("cmd --opt=val")).toBe("exec cmd --opt=val");
  });

  it("still prefixes when an env-like token is not the first token", () => {
    expect(wrapCommand("cmd FOO=bar")).toBe("exec cmd FOO=bar");
  });

  it("does not treat a digit-leading token as an env assignment", () => {
    expect(wrapCommand("1FOO=x cmd")).toBe("exec 1FOO=x cmd");
  });
});
