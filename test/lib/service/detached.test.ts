import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { DetachedRunner } from "../../../src/lib/service/detached.js";

// Real children exercise the synchronous compatibility API and shell gate.
describe("DetachedRunner", () => {
  it("returns a PID synchronously and preserves shell cwd/env/output", async () => {
    const lines: string[] = [];
    const onExit = vi.fn();
    const runner = new DetachedRunner({
      spawn: undefined,
      onLines: (_service, batch) => {
        lines.push(...batch);
      },
      onExit,
    });
    try {
      const pid = runner.start({
        service: "worker",
        generation: 7,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, VALUE: "literal '$ bytes" },
        command: String.raw`printf "%s\n" "$VALUE"; pwd`,
      });
      expect(pid).toBeGreaterThan(0);
      expect(runner.getPid("worker")).toBe(pid);
      await vi.waitFor(() => {
        expect(onExit).toHaveBeenCalledWith("worker", 7);
      });
      expect(lines).toEqual(["literal '$ bytes", process.cwd()]);
      expect(runner.isRunning("worker")).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  it("owns a separate group with ignored stdin and piped output", async () => {
    const spawnFn = vi.fn(spawn);
    const runner = new DetachedRunner({
      onLines: () => {
        /* No observer needed. */
      },
      onExit: () => {
        /* No observer needed. */
      },
      spawn: spawnFn,
    });
    try {
      runner.start({
        service: "worker",
        command: "exec cat",
        cwd: process.cwd(),
        env: process.env,
        generation: 0,
      });
      expect(spawnFn.mock.calls[0]?.[0]).toBe("sh");
      expect(spawnFn.mock.calls[0]?.[2]).toMatchObject({
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      await runner.stop("worker");
      expect(runner.getPid("worker")).toBe(-1);
    } finally {
      await runner.dispose();
    }
  });

  it("stops unknown services and repeated disposal", async () => {
    const runner = new DetachedRunner({
      onLines: () => {
        /* No observer needed. */
      },
      onExit: () => {
        /* No observer needed. */
      },
    });
    await runner.stop("missing");
    await runner.dispose();
    await runner.dispose();
  });
  it("handles spawn errors without retaining a missing PID", async () => {
    const onExit = vi.fn();
    const runner = new DetachedRunner({ onLines: vi.fn(), onExit });
    try {
      expect(
        runner.start({
          service: "missing",
          command: "true",
          cwd: "/nonexistent-zaps-test-dir",
          env: {},
          generation: 4,
        }),
      ).toBe(-1);
      await vi.waitFor(() => {
        expect(onExit).toHaveBeenCalledWith("missing", 4);
      });
      expect(runner.isRunning("missing")).toBe(false);
    } finally {
      await runner.dispose();
    }
  });
});
