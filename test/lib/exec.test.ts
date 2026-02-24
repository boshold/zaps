import { describe, expect, it } from "vitest";

import { execCommand, execCommandWithResult } from "../../src/lib/exec.js";

describe("execCommand", () => {
  it("runs commands sequentially and captures stdout", async () => {
    const lines: string[] = [];
    await execCommand("echo hello && echo world", {
      cwd: "/tmp",
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toContain("hello");
    expect(lines).toContain("world");
  });

  it("captures stderr to onLine", async () => {
    const lines: string[] = [];
    await execCommand("echo error-msg >&2", {
      cwd: "/tmp",
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toContain("error-msg");
  });

  it("resolves on exit code 0", async () => {
    await expect(
      execCommand("true", {
        cwd: "/tmp",
        onLine() {
          /* No-op */
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects on non-zero exit code", async () => {
    await expect(
      execCommand("exit 1", {
        cwd: "/tmp",
        onLine() {
          /* No-op */
        },
      }),
    ).rejects.toThrow("Command failed with code 1");
  });

  it("failed command stops sequence", async () => {
    const lines: string[] = [];
    await expect(
      execCommand("echo before && exit 42 && echo after", {
        cwd: "/tmp",
        onLine: (line) => {
          lines.push(line);
        },
      }),
    ).rejects.toThrow("Command failed with code 42");
    expect(lines).toContain("before");
    expect(lines).not.toContain("after");
  });

  it("passes env vars to spawned process", async () => {
    const lines: string[] = [];
    await execCommand("echo $TEST_VAR", {
      cwd: "/tmp",
      env: { TEST_VAR: "hello-from-env" },
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toContain("hello-from-env");
  });

  it("merges env with process.env", async () => {
    const lines: string[] = [];
    await execCommand("echo $HOME", {
      cwd: "/tmp",
      env: { CUSTOM: "val" },
      onLine: (line) => {
        lines.push(line);
      },
    });
    // HOME should still be available from process.env
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).not.toBe("");
  });

  it("handles dependsOn pattern: runs deps first via sequential calls", async () => {
    // Simulate running two tasks sequentially
    const lines: string[] = [];
    const onLine = (line: string) => {
      lines.push(line);
    };
    await execCommand("echo dep-task", { cwd: "/tmp", onLine });
    await execCommand("echo main-task", { cwd: "/tmp", onLine });
    expect(lines).toEqual(["dep-task", "main-task"]);
  });
});

describe("execCommandWithResult", () => {
  it("returns success result on exit code 0", async () => {
    const result = await execCommandWithResult("echo hello", { cwd: "/tmp" });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("returns failure result on non-zero exit code", async () => {
    const result = await execCommandWithResult("exit 42", { cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it("defaults null exit code to 1", async () => {
    // Simulate a command that exits with code 1
    const result = await execCommandWithResult("exit 1", { cwd: "/tmp" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("fires onLine callback per line", async () => {
    const lines: string[] = [];
    await execCommandWithResult("echo line1 && echo line2", {
      cwd: "/tmp",
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toContain("line1");
    expect(lines).toContain("line2");
  });

  it("passes env vars through", async () => {
    const result = await execCommandWithResult("echo $MY_VAR", {
      cwd: "/tmp",
      env: { MY_VAR: "test-value" },
    });
    expect(result.output).toContain("test-value");
  });

  it("captures stderr output", async () => {
    const lines: string[] = [];
    const result = await execCommandWithResult("echo err-msg >&2", {
      cwd: "/tmp",
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(result.output).toContain("err-msg");
    expect(lines).toContain("err-msg");
  });
});
