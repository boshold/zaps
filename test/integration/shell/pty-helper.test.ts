import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { createShellTestEnvironment, waitForCondition } from "./helpers.js";
import { requireShellPty, shellPty } from "./pty-helper.js";

describe("required shell PTY", () => {
  it("uses GNU command and exit-status flags on Linux", () => {
    expect(shellPty("printf 'literal command'", "linux")).toEqual({
      file: "script",
      args: ["-qec", "printf 'literal command'", "/dev/null"],
    });
  });

  it("runs the command argv through a Python PTY on macOS", () => {
    const { file, args } = shellPty("printf 'literal command'", "darwin");
    expect(file).toBe("python3");
    expect(args.slice(0, 1)).toEqual(["-c"]);
    expect(args.slice(2)).toEqual(["/bin/sh", "-c", "printf 'literal command'"]);
  });

  it("rejects unsupported hosts rather than guessing GNU flags", () => {
    expect(() => shellPty("true", "win32")).toThrow("unsupported");
  });

  it("requires actual TTY input/output, delivered keys and propagated child status", () => {
    requireShellPty();
  });
  it("cleans separate-session PTY descendants when acceptance fails", async () => {
    const fixture = createShellTestEnvironment({
      command: {
        file: process.execPath,
        args: ["-e", "console.log('PTY_CHILD_READY'); setInterval(() => {}, 1000)"],
      },
    });
    let terminalChild: ReturnType<typeof fixture.spawn> | undefined;
    await expect(async () => {
      try {
        terminalChild = fixture.spawn([], {}, { stdin: true, stdout: true });
        const child = terminalChild;
        await waitForCondition(() => child.stdout.includes("PTY_CHILD_READY"));
        const members = await child.refreshOwnership();
        expect(members.length).toBeGreaterThan(1);
        expect(new Set(members.map(({ sid }) => sid)).size).toBeGreaterThan(1);
        throw new Error("Simulated acceptance failure");
      } finally {
        await fixture.cleanup();
        fixture.assertNoTmux();
      }
    }).rejects.toThrow("Simulated acceptance failure");
    expect(fs.existsSync(fixture.rootDir)).toBe(false);
    expect(terminalChild?.child.exitCode !== null || terminalChild.child.signalCode !== null).toBe(
      true,
    );
  });
});
