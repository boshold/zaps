import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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
    const { runtime, send, wrappers } = fixture();
    const events: ExecutionEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    const handle = await runtime.start(spec);
    expect(send).toHaveBeenCalledWith(
      "%1",
      expect.stringContaining(`--execution-id '${handle.id}'`),
    );
    expect(wrappers.resolve({ service: "api", executionId: handle.id })).toEqual(info);
    expect(await runtime.getPid(handle)).toBe(123);
    expect(await runtime.readOutput(handle, 1)).toEqual(["world"]);
    expect(await runtime.isRunning(handle)).toBe(true);
    wrappers.exited({ service: "api", executionId: handle.id, code: 127, spawnError: "bad cwd" });
    wrappers.exited({ service: "api", executionId: handle.id, code: 127 });
    expect(events).toEqual(
      ["leaderExit", "exit"].map((kind) =>
        expect.objectContaining({ kind, unitId: "api", generation: 1, spawnError: "bad cwd" }),
      ),
    );
    expect(await runtime.isRunning(handle)).toBe(false);
    unsubscribe();
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
