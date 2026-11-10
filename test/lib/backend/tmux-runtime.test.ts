import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type { PaneCleanupOptions } from "#src/lib/backend/tmux/pane-cleanup.js";
import {
  TmuxRuntime,
  WrapperRegistry,
  wrapperIdentitySchema,
} from "#src/lib/backend/tmux/runtime.js";
import type { ExecutionEvent, ExecutionSpec } from "#src/lib/backend/types.js";
import { tmuxFor } from "#src/lib/tmux.js";

const info = { command: "echo hello", cwd: "/project", env: { KEY: "value" } };
const spec: ExecutionSpec = {
  ...info,
  unitId: "api",
  generation: 1,
  raw: false,
  placement: "default",
};
function fixture(options: PaneCleanupOptions = { readProcessIdentity: async () => null }) {
  const tmux = tmuxFor("owned-socket");
  const send = vi.spyOn(tmux, "sendKeys").mockResolvedValue();
  vi.spyOn(tmux, "sendCtrlC").mockResolvedValue();
  vi.spyOn(tmux, "paneExists").mockResolvedValue(true);
  vi.spyOn(tmux, "displayMessage").mockResolvedValue("0");
  vi.spyOn(tmux, "panePid").mockResolvedValue(123);
  vi.spyOn(tmux, "capturePane").mockResolvedValue("hello\nworld");
  const processes = new ProcessRunner({ onLines: vi.fn(), onExit: vi.fn() });
  const wrappers = new WrapperRegistry();
  const descendants = vi.fn<(pid: number) => Promise<number[]>>().mockResolvedValue([123]);
  const runtime = new TmuxRuntime({
    tmux,
    processes,
    wrappers,
    sessionId: "session",
    zapsCommand: "zaps",
    paneFor: () => "%1",
    getDescendantPids: descendants,
    ...options,
  });
  return { tmux, send, processes, wrappers, runtime, descendants };
}

describe("TmuxRuntime", () => {
  it("launches registered wrappers and translates one exit to original generation", async () => {
    const { runtime, send, wrappers, tmux } = fixture();
    const events: ExecutionEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const handle = await runtime.start(spec);
    expect(send).toHaveBeenCalledWith(
      "%1",
      expect.stringContaining(`--execution-id '${handle.id}'`),
    );
    expect(wrappers.resolve({ service: "api", executionId: handle.id })).toEqual(info);
    expect(await runtime.getPid(handle)).toBe(123);
    expect(await runtime.readOutput(handle, 1)).toEqual([]);
    expect(tmux.capturePane).not.toHaveBeenCalled();
    expect(await runtime.isRunning(handle)).toBe(true);
    wrappers.exited({ service: "api", executionId: handle.id, code: 127, spawnError: "bad cwd" });
    wrappers.exited({ service: "api", executionId: handle.id, code: 127 });
    expect(events.map((event) => event.kind)).toEqual(["leaderExit"]);
    await runtime.stop(handle);
    expect(events.filter((event) => event.kind !== "output")).toEqual(
      ["leaderExit", "exit"].map((kind) =>
        expect.objectContaining({ kind, unitId: "api", generation: 1, spawnError: "bad cwd" }),
      ),
    );
    expect(await runtime.isRunning(handle)).toBe(false);
    unsubscribe();
  });

  it("drains early wrapper diagnostics during pending sendKeys without leaking a producer", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, send, wrappers, tmux } = fixture();
      vi.mocked(tmux.capturePane).mockResolvedValue("FATAL");
      const events: ExecutionEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      let acknowledge!: () => void;
      send.mockImplementationOnce(async (_target, command) => {
        const executionId = /--execution-id '(?<executionId>[^']+)'/.exec(command)?.groups
          ?.executionId;
        if (!executionId) {
          throw new Error("missing execution id");
        }
        wrappers.exited({ service: "api", executionId, code: 0 });
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      });
      const starting = runtime.start(spec);
      acknowledge();
      const handle = await starting;
      await runtime.stop(handle);
      expect(await runtime.isRunning(handle)).toBe(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(tmux.capturePane).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.kind)).toEqual(["leaderExit", "output", "exit"]);
      expect(events[1]).toMatchObject({ generation: 1, lines: ["FATAL"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset or retain a replacement producer when an old send completes", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, send, wrappers, tmux } = fixture();
      let acknowledge!: () => void;
      send.mockImplementationOnce(async (_target, command) => {
        const executionId = /--execution-id '(?<executionId>[^']+)'/.exec(command)?.groups
          ?.executionId;
        if (!executionId) {
          throw new Error("missing execution id");
        }
        wrappers.exited({ service: "api", executionId, code: 0 });
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      });
      const retiredStart = runtime.start(spec);
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(tmux.capturePane).mockResolvedValue("hello\nworld\nreplacement ready");
      const replacement = await runtime.start({ ...spec, generation: 2 });
      const output = vi.fn();
      runtime.subscribe(output);
      await vi.advanceTimersByTimeAsync(250);
      expect(await runtime.readOutput(replacement, 2)).toEqual(["replacement ready"]);
      acknowledge();
      const retired = await retiredStart;
      expect(await runtime.isRunning(retired)).toBe(false);
      expect(await runtime.readOutput(replacement, 2)).toEqual(["replacement ready"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(output).toHaveBeenCalledExactlyOnceWith({
        kind: "output",
        unitId: "api",
        generation: 2,
        lines: ["replacement ready"],
      });
      expect(tmux.capturePane).toHaveBeenCalledTimes(3);
      await runtime.stop(replacement);
      await vi.advanceTimersByTimeAsync(500);
      expect(tmux.capturePane).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports leader exit immediately and final exit only after descendant cleanup", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, descendants, wrappers } = fixture();
      const events: ExecutionEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      const handle = await runtime.start(spec);
      descendants.mockResolvedValue([123, 124]);
      wrappers.exited({ service: "api", executionId: handle.id, code: 1 });
      expect(events.map((event) => event.kind)).toEqual(["leaderExit"]);
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      await vi.advanceTimersByTimeAsync(100);
      expect(events.some((event) => event.kind === "exit")).toBe(false);
      descendants.mockResolvedValue([123]);
      await vi.advanceTimersByTimeAsync(25);
      await runtime.stop(handle);
      expect(events.filter((event) => event.kind === "exit")).toEqual([
        expect.objectContaining({ kind: "exit", code: 1, generation: 1 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed unexpected-exit cleanup and reports final exit once across retry", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, descendants, wrappers } = fixture();
      const events: ExecutionEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      const handle = await runtime.start(spec);
      descendants.mockResolvedValue([123, 124]);
      wrappers.exited({ service: "api", executionId: handle.id, code: 1 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(events.filter((event) => event.kind === "exit")).toEqual([
        expect.objectContaining({
          cleanupError: expect.stringContaining("termination deadline exceeded"),
        }),
      ]);
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      descendants.mockResolvedValue([123]);
      await runtime.stop(handle);
      expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot consume or stop a replacement through an old identity", async () => {
    const { runtime, wrappers, tmux } = fixture();
    const first = await runtime.start(spec);
    await runtime.stop(first);
    const second = await runtime.start({ ...spec, generation: 2 });
    expect(wrappers.resolve({ service: "api", executionId: first.id })).toBeUndefined();
    wrappers.exited({ service: "api", executionId: first.id, code: 1 });
    await runtime.stop(first);
    expect(tmux.sendCtrlC).toHaveBeenCalledTimes(1);
    expect(await runtime.isRunning(second)).toBe(true);
    expect(wrappers.resolve({ service: "other", executionId: second.id })).toBeUndefined();
    expect(wrappers.resolve({ service: "api" })).toBeUndefined();
    expect(wrappers.resolve({ service: "api", executionId: second.id })).toEqual(info);
  });

  it("shares concurrent stops and cannot erase a replacement", async () => {
    const { runtime, tmux } = fixture();
    let acknowledge: () => void = () => {
      throw new Error("not initialized");
    };
    vi.mocked(tmux.sendCtrlC).mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const old = await runtime.start(spec);
    const first = runtime.stop(old);
    const second = runtime.stop(old);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(tmux.sendCtrlC).toHaveBeenCalledTimes(1));
    await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
    acknowledge();
    await first;
    const replacement = await runtime.start({ ...spec, generation: 2 });
    await second;
    await runtime.stop(old);
    expect(await runtime.isRunning(replacement)).toBe(true);
  });

  it("force kills verified interrupt-ignoring members after grace and preserves the pane shell", async () => {
    vi.useFakeTimers();
    try {
      const root: ProcessIdentity = { pid: 123, startTime: "shell", pgid: 123, sid: 123 };
      const child: ProcessIdentity = { pid: 124, startTime: "command", pgid: 124, sid: 123 };
      const identities = new Map([
        [root.pid, root],
        [child.pid, child],
      ]);
      const kill = vi.fn((pid: number, _signal: NodeJS.Signals) => {
        identities.delete(pid);
      });
      const { runtime, descendants } = fixture({
        readProcessIdentity: async (pid) => identities.get(pid) ?? null,
        kill,
      });
      descendants.mockImplementation(async () => [...identities.keys()]);
      const handle = await runtime.start(spec);
      const stopping = runtime.stop(handle);
      await vi.advanceTimersByTimeAsync(4999);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(26);
      await stopping;
      expect(kill).toHaveBeenCalledExactlyOnceWith(124, "SIGKILL");
      expect(identities.get(123)).toEqual(root);
      expect(await runtime.isRunning(handle)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not signal a reused member PID and retains unresolved cleanup", async () => {
    vi.useFakeTimers();
    try {
      const root: ProcessIdentity = { pid: 123, startTime: "shell", pgid: 123, sid: 123 };
      const child: ProcessIdentity = { pid: 124, startTime: "original", pgid: 124, sid: 123 };
      const identities = new Map([
        [root.pid, root],
        [child.pid, child],
      ]);
      const kill = vi.fn();
      const { runtime, descendants } = fixture({
        readProcessIdentity: async (pid) => identities.get(pid) ?? null,
        kill,
      });
      descendants.mockResolvedValue([123, 124]);
      const handle = await runtime.start(spec);
      const stopped = expect(runtime.stop(handle)).rejects.toThrow("identity unverifiable");
      await vi.advanceTimersByTimeAsync(2500);
      identities.set(124, { ...child, startTime: "reused" });
      await vi.advanceTimersByTimeAsync(2500);
      await stopped;
      expect(kill).not.toHaveBeenCalled();
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      descendants.mockResolvedValue([123]);
      await runtime.stop(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans recorded members even after the pane disappears during graceful stop", async () => {
    vi.useFakeTimers();
    try {
      const root: ProcessIdentity = { pid: 123, startTime: "shell", pgid: 123, sid: 123 };
      const child: ProcessIdentity = { pid: 124, startTime: "command", pgid: 124, sid: 123 };
      const identities = new Map([
        [root.pid, root],
        [child.pid, child],
      ]);
      const kill = vi.fn((pid: number, _signal: NodeJS.Signals) => {
        identities.delete(pid);
      });
      const { runtime, descendants, tmux } = fixture({
        readProcessIdentity: async (pid) => identities.get(pid) ?? null,
        kill,
      });
      descendants.mockResolvedValue([123, 124]);
      const handle = await runtime.start(spec);
      const stopping = runtime.stop(handle);
      await vi.advanceTimersByTimeAsync(100);
      vi.mocked(tmux.paneExists).mockResolvedValue(false);
      identities.delete(123);
      await vi.advanceTimersByTimeAsync(4925);
      await stopping;
      expect(kill).toHaveBeenCalledExactlyOnceWith(124, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals after a birth-verification deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const root: ProcessIdentity = { pid: 123, startTime: "shell", pgid: 123, sid: 123 };
      const child: ProcessIdentity = { pid: 124, startTime: "command", pgid: 124, sid: 123 };
      let complete!: (identity: ProcessIdentity) => void;
      const pending = new Promise<ProcessIdentity>((resolve) => {
        complete = resolve;
      });
      let blockAt = Infinity;
      const kill = vi.fn();
      const { runtime, descendants } = fixture({
        readProcessIdentity: async (pid) => {
          if (pid === 123) {
            return root;
          }
          return Date.now() >= blockAt ? pending : child;
        },
        kill,
      });
      descendants.mockResolvedValue([123, 124]);
      const handle = await runtime.start(spec);
      blockAt = Date.now() + 5000;
      const stopped = expect(runtime.stop(handle)).rejects.toThrow("termination deadline exceeded");
      await vi.advanceTimersByTimeAsync(6000);
      await stopped;
      complete(child);
      await vi.advanceTimersByTimeAsync(0);
      expect(kill).not.toHaveBeenCalled();
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds pending plus fresh shutdown capture under one drain deadline", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, tmux } = fixture();
      let finishCapture!: (output: string) => void;
      const handle = await runtime.start(spec);
      vi.mocked(tmux.capturePane)
        .mockImplementationOnce(
          async () =>
            new Promise<string>((resolve) => {
              finishCapture = resolve;
            }),
        )
        .mockResolvedValue("before\nFINAL");
      await vi.advanceTimersByTimeAsync(250);
      const stopped = expect(runtime.stop(handle)).rejects.toThrow("termination deadline exceeded");
      await vi.advanceTimersByTimeAsync(1000);
      await stopped;
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      finishCapture("before");
      await vi.advanceTimersByTimeAsync(0);
      await runtime.stop(handle);
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains ownership when an interrupt-ignoring command exceeds bounded stop", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, descendants, wrappers } = fixture();
      descendants.mockResolvedValue([123, 124]);
      const handle = await runtime.start(spec);
      const stopped = expect(runtime.stop(handle)).rejects.toThrow("Tmux cleanup incomplete");
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      expect(await runtime.isRunning(handle)).toBe(true);
      wrappers.exited({ service: "api", executionId: handle.id, code: 0 });
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      descendants.mockResolvedValue([123]);
      await runtime.stop(handle);
      expect(await runtime.isRunning(handle)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled termination probe and retains ownership", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, descendants } = fixture();
      descendants.mockImplementationOnce(
        async () =>
          new Promise<number[]>(() => {
            /* Pending probe. */
          }),
      );
      const handle = await runtime.start(spec);
      const stopped = expect(runtime.stop(handle)).rejects.toThrow("termination deadline exceeded");
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats the persistent pane shell as idle for raw commands", async () => {
    const { runtime, descendants } = fixture();
    const handle = await runtime.start({ ...spec, raw: true });
    descendants.mockResolvedValue([123]);
    expect(await runtime.isRunning(handle)).toBe(false);
    descendants.mockResolvedValue([123, 124]);
    expect(await runtime.isRunning(handle)).toBe(true);
  });

  it("cleans pending metadata when tmux launch fails", async () => {
    const { runtime, send, wrappers } = fixture();
    send.mockRejectedValueOnce(new Error("missing pane"));
    await expect(runtime.start(spec)).rejects.toThrow("missing pane");
    expect(wrappers.resolve({ service: "api" })).toBeUndefined();
  });

  it("delegates background commands to the owned ProcessRunner", async () => {
    const { runtime, send, processes } = fixture();
    const handle = { id: randomUUID(), unitId: "api", generation: 1 };
    const spawn = vi.spyOn(processes, "spawnOwned").mockReturnValue(handle);
    expect(await runtime.start({ ...spec, placement: "background" })).toEqual(handle);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: spec.command, unitId: "api", generation: 1 }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves pane history across restart without replaying logs or satisfying readiness", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, tmux } = fixture();
      const events: ExecutionEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      vi.mocked(tmux.capturePane).mockResolvedValue("old line\nOLD_READY");
      const first = await runtime.start(spec);
      await vi.advanceTimersByTimeAsync(250);
      await runtime.stop(first);
      const second = await runtime.start({ ...spec, generation: 2 });
      await vi.advanceTimersByTimeAsync(500);
      expect(await runtime.readOutput(second, 500)).toEqual([]);
      expect(events.filter((event) => event.kind === "output")).toEqual([
        { kind: "output", unitId: "api", generation: 1, lines: ["old line", "OLD_READY"] },
      ]);
      vi.mocked(tmux.capturePane).mockResolvedValue("old line\nOLD_READY\nNEW_READY");
      await vi.advanceTimersByTimeAsync(250);
      expect(await runtime.readOutput(second, 500)).toEqual(["NEW_READY"]);
      expect(events.findLast((event) => event.kind === "output")).toEqual({
        kind: "output",
        unitId: "api",
        generation: 2,
        lines: ["NEW_READY"],
      });
      await runtime.stop(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases its producer after a failed command dispatch", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, send, tmux } = fixture();
      send.mockRejectedValueOnce(new Error("dispatch failed"));
      await expect(runtime.start(spec)).rejects.toThrow("dispatch failed");
      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.capturePane).not.toHaveBeenCalled();
      const replacement = await runtime.start({ ...spec, generation: 2 });
      await vi.advanceTimersByTimeAsync(250);
      expect(tmux.capturePane).toHaveBeenCalledTimes(1);
      await runtime.stop(replacement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one capture stream for output subscriptions", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, tmux } = fixture();
      const first = vi.fn();
      const second = vi.fn();
      const removeFirst = runtime.subscribe(first);
      const removeSecond = runtime.subscribe(second);
      const handle = await runtime.start(spec);
      await vi.advanceTimersByTimeAsync(500);
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      expect(await runtime.readOutput(handle, 1)).toEqual(["world"]);
      expect(await runtime.readOutput(handle, 2)).toEqual(["hello", "world"]);
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "output", lines: ["hello", "world"] }),
      );
      removeFirst();
      removeSecond();
      await runtime.stop(handle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains its sole in-flight log capture before allowing a replacement", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, tmux, wrappers } = fixture();
      let finishCapture!: (value: string) => void;
      vi.mocked(tmux.capturePane)
        .mockImplementationOnce(
          async () =>
            new Promise<string>((resolve) => {
              finishCapture = resolve;
            }),
        )
        .mockResolvedValueOnce("final old output\nFINAL")
        .mockResolvedValue("replacement\nline\nready fragment");
      const events: ExecutionEvent[] = [];
      runtime.subscribe((event) => {
        events.push(event);
      });
      const first = await runtime.start(spec);
      await vi.advanceTimersByTimeAsync(250);
      wrappers.exited({ service: "api", executionId: first.id, code: 0 });
      await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
      await vi.advanceTimersByTimeAsync(0);
      finishCapture("final old output");
      await runtime.stop(first);
      const second = await runtime.start({ ...spec, generation: 2 });
      expect(await runtime.readOutput(second, 5)).toEqual([]);
      await vi.advanceTimersByTimeAsync(250);
      expect(tmux.capturePane).toHaveBeenCalledTimes(3);
      expect(events.filter((event) => event.kind === "output")).toEqual([
        { kind: "output", unitId: "api", generation: 1, lines: ["final old output"] },
        { kind: "output", unitId: "api", generation: 1, lines: ["FINAL"] },
        {
          kind: "output",
          unitId: "api",
          generation: 2,
          lines: ["replacement", "line", "ready fragment"],
        },
      ]);
      expect(await runtime.readOutput(second, 1)).toEqual(["ready fragment"]);
      expect(tmux.capturePane).toHaveBeenCalledTimes(3);
      await runtime.stop(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends raw commands with quoted cwd and environment", async () => {
    const { runtime, send, wrappers } = fixture();
    const handle = await runtime.start({ ...spec, raw: true, cwd: "/project with spaces" });
    expect(send).toHaveBeenCalledWith(
      "%1",
      "cd '/project with spaces' && env -i 'KEY=value' sh -c 'echo hello'",
    );
    expect(wrappers.resolve({ service: "api", executionId: handle.id })).toBeUndefined();
  });

  it("accepts missing identity only with explicit legacy registration", () => {
    const registry = new WrapperRegistry();
    const exited = vi.fn();
    registry.registerLegacy("api", info, exited);
    expect(registry.resolve({ service: "api" })).toEqual(info);
    registry.exited({ service: "api", code: 0 });
    registry.exited({ service: "api", code: 0 });
    expect(exited).toHaveBeenCalledTimes(1);
    expect(
      wrapperIdentitySchema.safeParse({ service: "api", executionId: "malformed" }).success,
    ).toBe(false);
  });
});
