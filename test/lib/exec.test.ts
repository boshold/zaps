import { describe, expect, it } from "vitest";

import { execCommand } from "../../src/lib/exec.js";

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
        onLine: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects on non-zero exit code", async () => {
    await expect(
      execCommand("exit 1", {
        cwd: "/tmp",
        onLine: () => {},
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
