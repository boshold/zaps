import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DetachedRunner } from "../../../src/lib/service/detached.js";
import type { DetachedRunnerDeps, SpawnFn } from "../../../src/lib/service/detached.js";

// --- Fake child process ---

class FakeChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly pid: number | undefined;

  public constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

interface Harness {
  runner: DetachedRunner;
  children: FakeChild[];
  spawnArgs: { file: string; args: string[]; opts: unknown }[];
  onLines: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  unrecord: ReturnType<typeof vi.fn>;
}

function makeHarness(nextPid = 4242): Harness {
  const children: FakeChild[] = [];
  const spawnArgs: Harness["spawnArgs"] = [];
  let pid = nextPid;

  const fakeSpawn = ((file: string, args: string[], opts: unknown) => {
    const child = new FakeChild(pid);
    pid += 1;
    children.push(child);
    spawnArgs.push({ file, args, opts });
    return child;
  }) as unknown as SpawnFn;

  const onLines = vi.fn();
  const onExit = vi.fn();
  const record = vi.fn();
  const unrecord = vi.fn();
  const deps: DetachedRunnerDeps = { onLines, onExit, record, unrecord, spawn: fakeSpawn };

  return {
    runner: new DetachedRunner(deps),
    children,
    spawnArgs,
    onLines,
    onExit,
    record,
    unrecord,
  };
}

function startWorker(h: Harness, generation = 0): FakeChild {
  h.runner.start({
    service: "worker",
    command: "node worker.js",
    cwd: "/proj",
    env: { PATH: "/usr/bin" },
    generation,
  });
  return h.children[h.children.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DetachedRunner.start", () => {
  it("spawns `sh -c <command>` detached with the resolved cwd/env", () => {
    const h = makeHarness();
    startWorker(h);
    expect(h.spawnArgs).toHaveLength(1);
    expect(h.spawnArgs[0].file).toBe("sh");
    expect(h.spawnArgs[0].args).toEqual(["-c", "node worker.js"]);
    expect(h.spawnArgs[0].opts).toMatchObject({
      cwd: "/proj",
      detached: true,
      env: { PATH: "/usr/bin" },
    });
  });

  it("records the spawned pid for orphan protection", () => {
    const h = makeHarness(5000);
    startWorker(h);
    expect(h.record).toHaveBeenCalledWith(5000);
    expect(h.runner.getPid("worker")).toBe(5000);
    expect(h.runner.isRunning("worker")).toBe(true);
  });
});

describe("DetachedRunner line splitting", () => {
  it("emits complete lines and carries a partial line across chunks", () => {
    const h = makeHarness();
    const child = startWorker(h);

    child.stdout.emit("data", Buffer.from("hel"));
    expect(h.onLines).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from("lo\nwor"));
    expect(h.onLines).toHaveBeenNthCalledWith(1, "worker", ["hello"]);

    child.stdout.emit("data", Buffer.from("ld\n"));
    expect(h.onLines).toHaveBeenNthCalledWith(2, "worker", ["world"]);

    expect(h.runner.getLines("worker")).toEqual(["hello", "world"]);
  });

  it("merges stdout and stderr into the same line stream", () => {
    const h = makeHarness();
    const child = startWorker(h);
    child.stdout.emit("data", Buffer.from("out line\n"));
    child.stderr.emit("data", Buffer.from("err line\n"));
    expect(h.runner.getLines("worker")).toEqual(["out line", "err line"]);
  });

  it("flushes a trailing partial line on exit", () => {
    const h = makeHarness();
    const child = startWorker(h);
    child.stdout.emit("data", Buffer.from("no newline here"));
    child.emit("exit", 0, null);
    expect(h.runner.getLines("worker")).toEqual([]); // Proc removed after exit
    expect(h.onLines).toHaveBeenCalledWith("worker", ["no newline here"]);
  });
});

describe("DetachedRunner exit handling", () => {
  it("routes an unexpected exit to onExit with the spawn generation", () => {
    const h = makeHarness();
    const child = startWorker(h, 7);
    child.emit("exit", 1, null);
    expect(h.onExit).toHaveBeenCalledWith("worker", 7);
    expect(h.unrecord).toHaveBeenCalledWith(4242);
    expect(h.runner.isRunning("worker")).toBe(false);
  });

  it("does not double-fire when both exit and error events arrive", () => {
    const h = makeHarness();
    const child = startWorker(h, 3);
    child.emit("exit", 1, null);
    child.emit("error", new Error("boom"));
    expect(h.onExit).toHaveBeenCalledTimes(1);
  });

  it("a stop-driven exit never triggers onExit (no crash-restart)", async () => {
    const h = makeHarness();
    const child = startWorker(h);
    const stopped = h.runner.stop("worker");
    child.emit("exit", null, "SIGTERM");
    await stopped;
    expect(h.onExit).not.toHaveBeenCalled();
  });
});

describe("DetachedRunner.stop", () => {
  it("SIGTERMs the process group, then SIGKILLs after the grace window", async () => {
    const h = makeHarness(8000);
    const child = startWorker(h);
    const kill = vi.mocked(process.kill);

    const stopped = h.runner.stop("worker");
    expect(kill).toHaveBeenCalledWith(-8000, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledWith(-8000, "SIGKILL");

    child.emit("exit", null, "SIGKILL");
    await stopped;
    expect(h.runner.isRunning("worker")).toBe(false);
  });

  it("resolves immediately for an unknown / already-exited service", async () => {
    const h = makeHarness();
    await expect(h.runner.stop("nope")).resolves.toBeUndefined();
  });

  it("stopAll stops every running service", async () => {
    const h = makeHarness();
    startWorker(h);
    h.runner.start({ service: "w2", command: "x", cwd: "/p", env: {}, generation: 0 });
    const all = h.runner.stopAll();
    for (const child of h.children) {
      child.emit("exit", null, "SIGTERM");
    }
    await all;
    expect(h.runner.isRunning("worker")).toBe(false);
    expect(h.runner.isRunning("w2")).toBe(false);
  });
});
