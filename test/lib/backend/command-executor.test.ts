import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { OwnedCommandExecutor } from "../../../src/lib/backend/runtime/command-executor.js";
import {
  ProcessAdmission,
  ProcessRunner,
} from "../../../src/lib/backend/runtime/process-runner.js";

function harness() {
  const admission = new ProcessAdmission();
  const runner = new ProcessRunner({
    admission,
    onLines: () => {
      /* No-op */
    },
    onExit: () => {
      /* No-op */
    },
  });
  const executor = new OwnedCommandExecutor(runner, admission.normal);
  const options = { cwd: process.cwd(), env: { ...process.env } };
  return { admission, runner, executor, options };
}

describe("OwnedCommandExecutor", () => {
  describe.each(["stdout", "stderr"] as const)("%s readline framing", (stream) => {
    it.each([
      { chunks: ["alpha\r\nbeta\rgamma\n"], expected: ["alpha", "beta", "gamma"] },
      { chunks: ["alpha\r", "\nbeta\r", "gamma\n"], expected: ["alpha", "beta", "gamma"] },
      { chunks: ["alpha\r", "\n"], expected: ["alpha"] },
      { chunks: ["alpha\r"], expected: ["alpha"] },
      { chunks: ["alpha", "\r", "\r", "\n"], expected: ["alpha", ""] },
      { chunks: ["\r", "\n", "\r", "\n"], expected: ["", ""] },
      { chunks: ["alpha\r", "beta"], expected: ["alpha", "beta"] },
      { chunks: [""], expected: [] },
    ])("frames $chunks without duplicate or missing lines", async ({ chunks, expected }) => {
      const child = new ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.defineProperties(child, {
        stdout: { value: stdout },
        stderr: { value: stderr },
        stdio: { value: [null, stdout, stderr, null] },
      });
      const runnerLines: string[] = [];
      const runner = new ProcessRunner({
        spawn: () => child,
        onLines: (_unitId, lines) => {
          runnerLines.push(...lines);
        },
        onExit: vi.fn(),
      });
      const lines: string[] = [];
      try {
        const result = new OwnedCommandExecutor(runner).execute("test", {
          cwd: process.cwd(),
          env: {},
          onLine: (line) => {
            lines.push(line);
          },
        });
        const target = stream === "stdout" ? stdout : stderr;
        for (const chunk of chunks) {
          target.write(chunk);
        }
        stdout.end();
        stderr.end();
        child.emit("exit", 0, null);
        expect(await result).toEqual({ success: true, exitCode: 0, output: expected });
        expect(lines).toEqual(expected);
        const rawLines = chunks.join("").split("\n");
        if (rawLines.at(-1) === "") {
          rawLines.pop();
        }
        expect(runnerLines).toEqual(rawLines);
      } finally {
        await runner.dispose();
      }
    });
  });

  it("captures cwd/env at admission, output tails and exit status", async () => {
    const h = harness();
    const lines: string[] = [];
    const options = {
      ...h.options,
      env: { ...h.options.env, CAPTURED: "original" },
      onLine: (line: string) => {
        lines.push(line);
      },
    };
    try {
      const result = h.executor.execute(
        String.raw`printf "%s\n%s\n" "$PWD" "$CAPTURED"; printf tail >&2; exit 7`,
        options,
      );
      options.env.CAPTURED = "changed";
      options.cwd = "/tmp";
      const final = await result;
      expect({ ...final, output: final.output.toSorted() }).toEqual({
        success: false,
        exitCode: 7,
        output: [process.cwd(), "original", "tail"].toSorted(),
      });
      expect(lines.toSorted()).toEqual([process.cwd(), "original", "tail"].toSorted());
    } finally {
      await h.runner.dispose();
    }
  });

  it("returns success and captures all output beyond the runner tail cap", async () => {
    const h = harness();
    try {
      const result = await h.executor.execute(
        'i=0; while [ "$i" -lt 510 ]; do echo "$i"; i=$((i+1)); done',
        h.options,
      );
      expect(result.success).toBe(true);
      expect(result.output).toHaveLength(510);
      expect(result.exitCode).toBe(0);
    } finally {
      await h.runner.dispose();
    }
  });

  it("returns spawn failure diagnostics", async () => {
    const h = harness();
    try {
      const result = await h.executor.execute("true", {
        ...h.options,
        cwd: "/does-not-exist-zaps",
      });
      expect(result.success).toBe(false);
      expect(result.output.join("\n")).toContain("ENOENT");
    } finally {
      await h.runner.dispose();
    }
  });

  it("cancels an active owned command and flushes output", async () => {
    const h = harness();
    const controller = new AbortController();
    try {
      const result = await h.executor.execute("echo ready; exec tail -f /dev/null", {
        ...h.options,
        signal: controller.signal,
        onLine: () => {
          controller.abort();
        },
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("ready");
      expect(result.output).toContain("Command cancelled");
    } finally {
      await h.runner.dispose();
    }
  });

  it("rejects normal admission atomically while allowing tracked private cleanup", async () => {
    const h = harness();
    const scope = h.admission.createCleanupScope(Date.now() + 10_000);
    const cleanup = new OwnedCommandExecutor(h.runner, scope.authority);
    const spec = { command: "true", unitId: "late", generation: 1, ...h.options };
    try {
      const captured = h.executor.execute.bind(h.executor);
      h.admission.close();
      await expect(captured("true", h.options)).rejects.toThrow("session_closing");
      expect(() => h.runner.spawnOwned({ ...spec, authority: h.admission.normal })).toThrow(
        "session_closing",
      );
      const cleanupResult = await cleanup.execute("echo cleanup", h.options);
      expect(cleanupResult.output).toEqual(["cleanup"]);
      scope.revoke();
      await expect(cleanup.execute("true", h.options)).rejects.toThrow("session_closing");
      expect(() => h.runner.spawnOwned({ ...spec, authority: scope.authority })).toThrow(
        "session_closing",
      );
      expect(() =>
        h.runner.spawnOwned({ ...spec, authority: { signal: new AbortController().signal } }),
      ).toThrow("session_closing");
    } finally {
      scope.revoke();
      await h.runner.dispose();
    }
  });

  it("revokes running cleanup children at their deadline", async () => {
    const h = harness();
    const scope = h.admission.createCleanupScope(Date.now() + 200);
    h.admission.close();
    try {
      const result = await new OwnedCommandExecutor(h.runner, scope.authority).execute(
        "echo cleanup; exec tail -f /dev/null",
        h.options,
      );
      expect(result.success).toBe(false);
      expect(scope.authority.signal.aborted).toBe(true);
      expect(h.runner.admits(scope.authority)).toBe(false);
    } finally {
      scope.revoke();
      await h.runner.dispose();
    }
  });

  it("seals both admission paths on owner disposal", async () => {
    const h = harness();
    const scope = h.admission.createCleanupScope(Date.now() + 10_000);
    const cleanup = new OwnedCommandExecutor(h.runner, scope.authority);
    h.admission.dispose();
    await expect(cleanup.execute("true", h.options)).rejects.toThrow("session_closing");
    expect(() =>
      h.runner.spawnOwned({
        command: "true",
        unitId: "late",
        generation: 1,
        ...h.options,
        authority: scope.authority,
      }),
    ).toThrow("session_closing");
    await h.runner.dispose();
  });

  it("seals and revokes cleanup scopes when the runner is disposed", async () => {
    const h = harness();
    const scope = h.admission.createCleanupScope(Date.now() + 10_000);
    await h.runner.dispose();
    expect(scope.authority.signal.aborted).toBe(true);
    expect(h.admission.allows(scope.authority)).toBe(false);
    await expect(
      new OwnedCommandExecutor(h.runner, scope.authority).execute("true", h.options),
    ).rejects.toThrow("session_closing");
  });

  it("blocks the payload when admission closes during registration", async () => {
    const admission = new ProcessAdmission();
    const onLines = vi.fn();
    const runner = new ProcessRunner({
      admission,
      onLines,
      onExit: vi.fn(),
      record: () => {
        admission.close();
      },
    });
    try {
      const result = await new OwnedCommandExecutor(runner, admission.normal).execute(
        "echo forbidden",
        { cwd: process.cwd(), env: { ...process.env } },
      );
      expect(result.success).toBe(false);
      expect(onLines).not.toHaveBeenCalled();
    } finally {
      await runner.dispose();
    }
  });

  it("disposes active commands with final failure diagnostics", async () => {
    const h = harness();
    const onLine = vi.fn();
    const result = h.executor.execute("echo ready; exec tail -f /dev/null", {
      ...h.options,
      onLine,
    });
    await vi.waitFor(() => {
      expect(onLine).toHaveBeenCalledWith("ready");
    });
    await h.runner.dispose();
    const final = await result;
    expect(final.success).toBe(false);
  });
});
