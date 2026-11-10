import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "../../../src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "../../../src/lib/backend/runtime/process-runner.js";

function harness() {
  const identity: ProcessIdentity = { pid: 4242, startTime: "birth", pgid: 4242, sid: "abcd" };
  const live = new Map<number, ProcessIdentity>([[identity.pid, identity]]);
  const child = new ChildProcess();
  const gate = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(child, {
    pid: { value: identity.pid },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate] },
  });
  let now = 0;
  const signals: { pid: number; signal: NodeJS.Signals; at: number }[] = [];
  const record = vi.fn();
  const closeStreams = () => {
    stdout.destroy();
    stderr.destroy();
  };
  child.on("exit", closeStreams);
  const unrecord = vi.fn(closeStreams);
  const onExit = vi.fn();
  const onLines = vi.fn();
  const diagnostic = vi.fn();
  const deps = {
    spawn: () => child,
    readProcessIdentity: async (pid: number) => live.get(pid) ?? null,
    getProcessMembers: async () => [...live.values()],
    kill: (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal, at: now });
    },
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
    record,
    unrecord,
    onExit,
    onLines,
    diagnostic,
  };
  return {
    closeStreams,
    identity,
    live,
    child,
    gate,
    stdout,
    signals,
    deps,
    record,
    unrecord,
    onExit,
    diagnostic,
  };
}
const spec = { unitId: "worker", generation: 3, command: "payload", cwd: process.cwd(), env: {} };

describe("ProcessRunner ownership lifecycle", () => {
  it("registers ownership before releasing the payload; returns opaque correlated handles", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ProcessRunner({ ...h.deps, record: async () => registered });
    const handle = runner.spawnOwned(spec);
    expect(handle).toMatchObject({ unitId: "worker", generation: 3 });
    expect(handle.id).not.toBe(String(h.identity.pid));
    expect(h.gate.readableLength).toBe(0);
    release?.();
    await vi.waitFor(() => {
      expect(h.gate.readableLength).toBeGreaterThan(0);
    });
    h.live.clear();
    h.child.emit("exit", 0, null);
    await vi.waitFor(() => {
      expect(h.onExit).toHaveBeenCalledOnce();
    });
    await runner.dispose();
  });

  it("closes normal admission before a delayed registration can release its payload", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ProcessRunner({ ...h.deps, record: async () => registered });
    runner.spawnOwned(spec);
    runner.closeAdmission();
    expect(() => runner.spawnOwned({ ...spec, unitId: "late" })).toThrow("session_closing");
    release?.();
    await vi.waitFor(() => expect(h.gate.destroyed).toBe(true));
    expect(h.gate.readableLength).toBe(0);
    h.live.clear();
    h.child.emit("exit", 125, null);
    await runner.dispose();
  });

  it("rejects replacement and admission after disposal", async () => {
    const h = harness();
    const runner = new ProcessRunner(h.deps);
    const handle = runner.spawnOwned(spec);
    expect(() => runner.spawnOwned(spec)).toThrow("still owned");
    h.live.clear();
    await runner.stop(handle);
    await runner.dispose();
    expect(() => runner.spawnOwned({ ...spec, unitId: "other" })).toThrow("session_closing");
  });

  it("uses TERM5000/KILL1000, retains unresolved evidence and retries idempotently", async () => {
    const h = harness();
    const runner = new ProcessRunner(h.deps);
    const handle = runner.spawnOwned(spec);
    await vi.waitFor(() => {
      expect(h.record).toHaveBeenCalledOnce();
    });
    h.closeStreams();
    const first = runner.stop(handle);
    expect(runner.stop(handle)).toBe(first);
    await expect(first).rejects.toThrow("survived SIGKILL");
    expect(h.signals).toEqual([
      { pid: 4242, signal: "SIGTERM", at: 0 },
      { pid: 4242, signal: "SIGKILL", at: 5000 },
    ]);
    expect(h.unrecord).not.toHaveBeenCalled();
    expect(runner.getPid(handle)).toBe(4242);
    h.live.clear();
    await runner.stop(handle);
    await runner.stop(handle);
    expect(h.unrecord).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it("does not signal reused births; retains unverified group candidates", async () => {
    const h = harness();
    const runner = new ProcessRunner(h.deps);
    const handle = runner.spawnOwned(spec);
    await vi.waitFor(() => {
      expect(h.gate.readableLength).toBeGreaterThan(0);
    });
    h.closeStreams();
    h.live.set(4242, { ...h.identity, startTime: "reused" });
    await expect(runner.stop(handle)).rejects.toThrow("Unverified");
    expect(h.signals).toEqual([]);
    h.live.clear();
    await runner.dispose();
  });

  it("stop before registration completes never releases payload", async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ProcessRunner({
      ...h.deps,
      record: async () => registered,
      kill: (pid) => {
        h.live.delete(pid);
      },
    });
    const handle = runner.spawnOwned(spec);
    const stopped = runner.stop(handle);
    release?.();
    await stopped;
    expect(h.gate.readableLength).toBe(0);
    expect(h.onExit).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it("cleans verified surviving members after leader exit", async () => {
    const h = harness();
    const member = { ...h.identity, pid: 4243, startTime: "child" };
    h.live.set(member.pid, member);
    const runner = new ProcessRunner({
      ...h.deps,
      kill: (pid) => {
        h.live.delete(pid);
      },
    });
    runner.spawnOwned(spec);
    await vi.waitFor(() => {
      expect(h.gate.readableLength).toBeGreaterThan(0);
    });
    h.live.delete(h.identity.pid);
    h.child.emit("exit", 1, null);
    await vi.waitFor(() => {
      expect(h.onExit).toHaveBeenCalledWith("worker", 3);
    });
    expect(h.live.size).toBe(0);
    await runner.dispose();
  });
  it("cleans a rejected registration without running the payload", async () => {
    const h = harness();
    const runner = new ProcessRunner({
      ...h.deps,
      record: async () => {
        throw new Error("journal failed");
      },
      kill: (pid) => {
        h.live.delete(pid);
      },
    });
    const handle = runner.spawnOwned(spec);
    await vi.waitFor(() => {
      expect(runner.getPid(handle)).toBe(-1);
    });
    expect(h.gate.readableLength).toBe(0);
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining("journal failed"));
    await runner.dispose();
  });

  it("continues cleanup when one member disappears while signalling", async () => {
    const h = harness();
    const member = { ...h.identity, pid: 4243, startTime: "child" };
    h.live.set(member.pid, member);
    const signalled: number[] = [];
    const runner = new ProcessRunner({
      ...h.deps,
      kill: (pid) => {
        signalled.push(pid);
        h.live.delete(pid);
        if (pid === 4242) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
    });
    const handle = runner.spawnOwned(spec);
    await vi.waitFor(() => {
      expect(h.gate.readableLength).toBeGreaterThan(0);
    });
    await runner.stop(handle);
    expect(signalled).toEqual([4242, 4243]);
    await runner.dispose();
  });

  it("keeps complete-line output compatible across chunks and streams", async () => {
    const h = harness();
    const runner = new ProcessRunner(h.deps);
    const handle = runner.spawnOwned(spec);
    h.stdout.write("hel");
    h.stdout.write("lo\npart");
    expect(runner.getLines(handle)).toEqual(["hello"]);
    h.stdout.write("ial\n");
    expect(runner.getLines(handle)).toEqual(["hello", "partial"]);
    h.live.clear();
    await runner.dispose();
  });
  it.each(["null", "rejected"])(
    "finalizes a confirmed unlaunched shell after %s birth lookup",
    async (failure) => {
      const onExit = vi.fn();
      const onLines = vi.fn();
      const runner = new ProcessRunner({
        onExit,
        onLines,
        diagnostic: vi.fn(),
        readProcessIdentity: async () => {
          if (failure === "rejected") {
            throw new Error("inspection failed");
          }
          return null;
        },
      });
      try {
        const handle = runner.spawnOwned({ ...spec, command: "printf 'payload must not run\\n'" });
        await vi.waitFor(() => {
          expect(onExit).toHaveBeenCalledOnce();
        });
        expect(runner.getPid(handle)).toBe(-1);
        expect(onLines).not.toHaveBeenCalled();
        const replacement = runner.spawnOwned({ ...spec, command: "true" });
        expect(replacement.id).not.toBe(handle.id);
        await vi.waitFor(() => {
          expect(onExit).toHaveBeenCalledTimes(2);
        });
      } finally {
        await runner.dispose();
      }
    },
  );

  it.each([900, 1500])(
    "bounds %i ms KILL verification and ignores late probes",
    async (killProbeMs) => {
      vi.useFakeTimers();
      const h = harness();
      let slow = false;
      const started = Date.now();
      const runner = new ProcessRunner({
        ...h.deps,
        now: Date.now,
        wait: async (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        readProcessIdentity: async (pid) => {
          if (slow) {
            const duration = Date.now() - started >= 5000 ? killProbeMs : 900;
            await new Promise((resolve) => {
              setTimeout(resolve, duration);
            });
          }
          return h.live.get(pid) ?? null;
        },
        kill: (pid, signal) => {
          h.signals.push({ pid, signal, at: Date.now() });
        },
      });
      try {
        const handle = runner.spawnOwned(spec);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.gate.readableLength).toBeGreaterThan(0);
        h.closeStreams();
        await vi.advanceTimersByTimeAsync(0);
        slow = true;
        const result = expect(runner.stop(handle)).rejects.toThrow("deadline");
        await vi.advanceTimersByTimeAsync(6000);
        await result;
        expect(h.signals).toEqual(
          killProbeMs === 900
            ? [
                { pid: 4242, signal: "SIGTERM", at: started + 2700 },
                { pid: 4242, signal: "SIGKILL", at: started + 5900 },
              ]
            : [{ pid: 4242, signal: "SIGTERM", at: started + 2700 }],
        );
        expect(Date.now() - started).toBe(6000);
        expect(runner.getPid(handle)).toBe(4242);
        expect(h.unrecord).not.toHaveBeenCalled();
        const signals = [...h.signals];
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.signals).toEqual(signals);
        slow = false;
        h.live.clear();
        await runner.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retains an unlaunched child until direct completion is confirmed", async () => {
    const h = harness();
    const runner = new ProcessRunner({ ...h.deps, readProcessIdentity: async () => null });
    const handle = runner.spawnOwned(spec);
    h.closeStreams();
    await expect(runner.stop(handle)).rejects.toThrow("Unresolved ownership");
    expect(runner.getPid(handle)).toBe(4242);
    expect(h.signals).toEqual([]);
    expect(() => runner.spawnOwned(spec)).toThrow("still owned");
    h.child.emit("exit", 125, null);
    await vi.waitFor(() => {
      expect(runner.getPid(handle)).toBe(-1);
    });
    await runner.dispose();
  });
});
