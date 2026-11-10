import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "../../../src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "../../../src/lib/backend/runtime/process-runner.js";
import type { ExecutionEvent } from "../../../src/lib/backend/types.js";

const spec = { unitId: "worker", generation: 3, command: "payload", cwd: process.cwd(), env: {} };

function harness() {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const gate = new PassThrough();
  const identity: ProcessIdentity = { pid: 4242, startTime: "birth", pgid: 4242, sid: 4242 };
  const live = new Map([[identity.pid, identity]]);
  Object.defineProperties(child, {
    pid: { value: identity.pid },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate] },
  });
  const onLines = vi.fn();
  const onExit = vi.fn();
  const events: ExecutionEvent[] = [];
  const runner = new ProcessRunner({
    spawn: () => child,
    onLines,
    onExit,
    readProcessIdentity: async (pid) => live.get(pid) ?? null,
    getProcessMembers: async () => [...live.values()],
    kill: (pid) => {
      live.delete(pid);
    },
    diagnostic: vi.fn(),
  });
  runner.subscribe((event) => {
    events.push(event);
  });
  const handle = runner.spawnOwned(spec);
  const ready = async () => {
    await vi.waitFor(() => {
      expect(gate.readableLength).toBeGreaterThan(0);
    });
  };
  const exit = () => {
    live.clear();
    child.emit("exit", 2, "SIGTERM");
  };
  const close = () => {
    stdout.end();
    stderr.end();
  };
  return {
    child,
    stdout,
    stderr,
    runner,
    onLines,
    onExit,
    events,
    handle,
    ready,
    exit,
    close,
    live,
  };
}

describe("ProcessRunner output and terminal ordering", () => {
  it("decodes each UTF8 stream incrementally; projects readiness tails without publishing them", async () => {
    const h = harness();
    await h.ready();
    const stdoutBytes = Buffer.from("hello 😀\nready");
    const stderrBytes = Buffer.from("é\nwarning");
    h.stdout.write(stdoutBytes.subarray(0, 8));
    h.stderr.write(stderrBytes.subarray(0, 1));
    expect(h.runner.readOutput(h.handle, 500)).toEqual(["hello "]);
    expect(h.onLines).not.toHaveBeenCalled();
    h.stdout.write(stdoutBytes.subarray(8));
    h.stderr.write(stderrBytes.subarray(1));
    expect(h.runner.getLines(h.handle)).toEqual(["hello 😀", "é"]);
    expect(h.runner.readOutput(h.handle, 500)).toEqual(["hello 😀", "é", "ready", "warning"]);
    expect(h.runner.readOutput(h.handle, 2)).toEqual(["ready", "warning"]);
    expect(h.runner.readOutput(h.handle, 0)).toEqual([]);
    expect(h.onLines.mock.calls.flatMap((call) => call[1])).toEqual(["hello 😀", "é"]);
    h.exit();
    expect(h.events.filter((event) => event.kind === "leaderExit")).toEqual([
      { kind: "leaderExit", unitId: "worker", generation: 3, code: 2, signal: "SIGTERM" },
    ]);
    expect(h.events.some((event) => event.kind === "exit")).toBe(false);
    h.stderr.write(" after exit");
    h.close();
    await h.runner.stop(h.handle);
    expect(h.onLines.mock.calls.flatMap((call) => call[1])).toEqual([
      "hello 😀",
      "é",
      "ready",
      "warning after exit",
    ]);
    expect(h.events.at(-1)).toMatchObject({ kind: "exit", code: 2, signal: "SIGTERM" });
    h.child.emit("exit", 2, "SIGTERM");
    h.child.emit("error", new Error("late"));
    expect(h.events.filter((event) => event.kind === "exit")).toHaveLength(1);
    expect(h.onExit).toHaveBeenCalledOnce();
    await h.runner.dispose();
  });

  it("retains only 500 readiness lines including partial projections", async () => {
    const h = harness();
    await h.ready();
    h.stdout.write(`${Array.from({ length: 510 }, (_, i) => String(i)).join("\n")}\ntail`);
    expect(h.runner.getLines(h.handle)).toHaveLength(500);
    expect(h.runner.readOutput(h.handle, 1000)).toHaveLength(500);
    expect(h.runner.readOutput(h.handle, 1000).at(-1)).toBe("tail");
    h.exit();
    h.close();
    await h.runner.dispose();
  });

  it("bounds inherited open pipes at DRAIN1000 and flushes fragments once", async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await vi.advanceTimersByTimeAsync(0);
      h.stdout.write("tail");
      h.stderr.write(Buffer.from([195]));
      h.exit();
      const stopped = h.runner.stop(h.handle);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.events.some((event) => event.kind === "exit")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopped;
      expect(h.events.at(-1)).toMatchObject({ kind: "exit", drainTimedOut: true });
      expect(h.onLines.mock.calls.flatMap((call) => call[1])).toEqual(["tail", "�"]);
      expect(h.stdout.destroyed).toBe(true);
      h.close();
      await h.runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes failed cleanup once and keeps ownership blocking replacement until retry succeeds", async () => {
    const h = harness();
    await h.ready();
    h.live.set(4242, { pid: 4242, pgid: 4242, sid: 4242, startTime: "reused" });
    h.close();
    h.child.emit("exit", 1, null);
    await expect(h.runner.stop(h.handle)).rejects.toThrow("Unverified");
    expect(h.events.at(-1)).toMatchObject({
      kind: "exit",
      code: 1,
      cleanupError: expect.stringContaining("Unverified"),
    });
    expect(h.runner.getPid(h.handle)).toBe(4242);
    expect(() => h.runner.spawnOwned(spec)).toThrow("still owned");
    h.live.clear();
    await h.runner.stop(h.handle);
    expect(h.runner.getPid(h.handle)).toBe(-1);
    expect(h.events.filter((event) => event.kind === "exit")).toHaveLength(1);
    await h.runner.dispose();
  });

  it("deduplicates spawn error/exit races and reports the spawn error", async () => {
    const events: ExecutionEvent[] = [];
    const runner = new ProcessRunner({ onLines: vi.fn(), onExit: vi.fn(), diagnostic: vi.fn() });
    runner.subscribe((event) => {
      events.push(event);
    });
    const handle = runner.spawnOwned({ ...spec, cwd: "/nonexistent-zaps-output-fixture" });
    await vi.waitFor(() => {
      expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
    });
    expect(events.map((event) => event.kind)).toEqual(["leaderExit", "exit"]);
    expect(events.at(-1)).toMatchObject({
      code: null,
      signal: null,
      spawnError: expect.stringContaining("ENOENT"),
    });
    expect(runner.getPid(handle)).toBe(-1);
    await runner.dispose();
  });

  it("finalizes a real exited leader while an escaped grandchild holds stdout open", async () => {
    const events: ExecutionEvent[] = [];
    let grandchild: number | undefined;
    const runner = new ProcessRunner({
      onLines: (_unitId, lines) => {
        for (const line of lines) {
          if (line.startsWith("grandchild:")) {
            grandchild = Number(line.slice(11));
          }
        }
      },
      onExit: vi.fn(),
    });
    runner.subscribe((event) => {
      events.push(event);
    });
    const script =
      'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore",1,2]});console.log("grandchild:"+child.pid);child.unref();';
    const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;
    try {
      runner.spawnOwned({
        ...spec,
        command: `${quote(process.execPath)} -e ${quote(script)}`,
        env: process.env,
      });
      await vi.waitFor(
        () => {
          expect(events.some((event) => event.kind === "leaderExit")).toBe(true);
        },
        { timeout: 4000 },
      );
      expect(grandchild).toBeGreaterThan(0);
      await vi.waitFor(
        () => {
          expect(events.at(-1)).toMatchObject({ kind: "exit", drainTimedOut: true });
        },
        { timeout: 3000 },
      );
      expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
    } finally {
      if (grandchild) {
        process.kill(grandchild, "SIGKILL");
      }
      await runner.dispose();
    }
  });
});
