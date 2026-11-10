import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { LogBuffer } from "#src/daemon/log-buffer.js";
import { LogMonitor } from "#src/daemon/log-monitor.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
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
function fixture() {
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

  it("does not capture after a wrapper exits during pending sendKeys", async () => {
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
      const starting = runtime.start(spec);
      acknowledge();
      const handle = await starting;
      await runtime.stop(handle);
      expect(await runtime.isRunning(handle)).toBe(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(tmux.capturePane).not.toHaveBeenCalled();
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
      const replacement = await runtime.start({ ...spec, generation: 2 });
      const output = vi.fn();
      runtime.subscribe(output);
      await vi.advanceTimersByTimeAsync(250);
      expect(await runtime.readOutput(replacement, 2)).toEqual(["hello", "world"]);
      acknowledge();
      const retired = await retiredStart;
      expect(await runtime.isRunning(retired)).toBe(false);
      expect(await runtime.readOutput(replacement, 2)).toEqual(["hello", "world"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(output).toHaveBeenCalledExactlyOnceWith({
        kind: "output",
        unitId: "api",
        generation: 2,
        lines: ["hello", "world"],
      });
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      await runtime.stop(replacement);
      await vi.advanceTimersByTimeAsync(500);
      expect(tmux.capturePane).toHaveBeenCalledTimes(3);
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
    expect(tmux.sendCtrlC).toHaveBeenCalledTimes(1);
    await expect(runtime.start({ ...spec, generation: 2 })).rejects.toThrow("still owned");
    acknowledge();
    await first;
    const replacement = await runtime.start({ ...spec, generation: 2 });
    await second;
    await runtime.stop(old);
    expect(await runtime.isRunning(replacement)).toBe(true);
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

  it("drains shared in-flight log capture before allowing a replacement", async () => {
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
        .mockResolvedValue("replacement\nready fragment");
      const buffer = new LogBuffer();
      const log = vi.fn();
      const monitor = new LogMonitor(
        { capturePane: tmux.capturePane },
        new Map([["%1", buffer]]),
        log,
      );
      monitor.start("%1", "%1", 250);
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
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.kind === "output")).toEqual([
        { kind: "output", unitId: "api", generation: 1, lines: ["final old output"] },
        { kind: "output", unitId: "api", generation: 2, lines: ["replacement", "ready fragment"] },
      ]);
      expect(buffer.snapshot()).toEqual(["final old output", "replacement", "ready fragment"]);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenLastCalledWith("%1", ["replacement", "ready fragment"]);
      expect(await runtime.readOutput(second, 1)).toEqual(["ready fragment"]);
      expect(tmux.capturePane).toHaveBeenCalledTimes(2);
      await runtime.stop(second);
      monitor.stopAll();
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
