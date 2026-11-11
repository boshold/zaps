import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogBuffer } from "#src/daemon/log-buffer.js";
import { LogMonitor } from "#src/daemon/log-monitor.js";
import { TmuxOutputProducer, acquireTmuxOutput } from "#src/lib/backend/tmux/output.js";
import { waitForReady } from "#src/lib/service/ready.js";

describe("tmux output producer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares batches across log buffers, hooks and combined members", async () => {
    const capture = vi.fn(async () => "first\npartial");
    const buffer = new LogBuffer();
    const members = new Map([
      ["owner", vi.fn()],
      ["member", vi.fn()],
    ]);
    const monitor = new LogMonitor(
      { capturePane: capture },
      new Map([["%1", buffer]]),
      (_key, lines) => {
        for (const listener of members.values()) {
          listener(lines);
        }
      },
    );
    monitor.start("%1", "%1", 100);
    const runtime = acquireTmuxOutput(capture, "%1", 100);
    const hook = vi.fn();
    const extra = vi.fn();
    runtime.producer.subscribe(hook);
    runtime.producer.subscribe(extra);
    await vi.advanceTimersByTimeAsync(300);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(buffer.snapshot()).toEqual(["first", "partial"]);
    expect(hook).toHaveBeenCalledExactlyOnceWith(["first", "partial"]);
    expect(extra).toHaveBeenCalledExactlyOnceWith(["first", "partial"]);
    for (const listener of members.values()) {
      expect(listener).toHaveBeenCalledExactlyOnceWith(["first", "partial"]);
    }
    expect(runtime.producer.read(1)).toEqual(["partial"]);
    expect(runtime.producer.readComplete(5)).toEqual(["first"]);
    expect(capture).toHaveBeenCalledTimes(3);
    monitor.stopAll();
    runtime.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("preserves scrolling and progress rewrites without repeating the window", async () => {
    const capture = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("a\nb\n50%")
      .mockResolvedValueOnce("a\nb\n60%")
      .mockResolvedValueOnce("a\nb\ndone\n100%")
      .mockResolvedValueOnce("b\ndone\n100%\nnext");
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(400);
    expect(listener.mock.calls).toEqual([[["a", "b", "50%"]], [["done"]], [["next"]]]);
    producer.stop();
  });

  it("publishes appended logs above fixed footer padding once", async () => {
    const header = "docker compose up";
    const ready = "redis-1 | Ready to accept connections tcp";
    const footer = "w Enable Watch   d Detach";
    const restarted = "memcached-1 exited with code 0 (restarting)";
    const saved = "redis-1 | DB saved on disk";
    const capture = vi.fn(async () => [header, ready, "", "", "", footer].join("\n"));
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn<(lines: string[]) => void>();
    producer.subscribe(listener);
    try {
      await vi.advanceTimersByTimeAsync(100);
      listener.mockClear();
      capture.mockResolvedValue([header, ready, restarted, saved, "", footer].join("\n"));
      await vi.advanceTimersByTimeAsync(300);
      expect(listener).toHaveBeenCalledExactlyOnceWith([restarted, saved]);
      expect(producer.read(10)).toEqual([header, ready, restarted, saved, "", footer]);
    } finally {
      producer.stop();
    }
  });

  it("does not replay progress or footer rewrites in a padded viewport", async () => {
    const capture = vi.fn(async () => "header\n50%\n\nfooter");
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn<(lines: string[]) => void>();
    producer.subscribe(listener);
    try {
      await vi.advanceTimersByTimeAsync(100);
      listener.mockClear();
      capture.mockResolvedValue("header\n60%\n\nfooter");
      await vi.advanceTimersByTimeAsync(100);
      capture.mockResolvedValue("header\n60%\n\nupdated footer");
      await vi.advanceTimersByTimeAsync(100);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      producer.stop();
    }
  });

  it("discards an old in-flight generation and clears the readiness cache", async () => {
    let finishCapture!: (value: string) => void;
    const capture = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementationOnce(
        async () =>
          new Promise<string>((resolve) => {
            finishCapture = resolve;
          }),
      )
      .mockResolvedValue("new\nready fragment");
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(200);
    producer.reset();
    expect(producer.read(5)).toEqual([]);
    finishCapture("stale");
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.mock.calls).toEqual([[["old"]], [["new", "ready fragment"]]]);
    expect(producer.read(1)).toEqual(["ready fragment"]);
    producer.stop();
  });

  it("clears readiness on restart without republishing retained pane history", async () => {
    const capture = vi.fn(async () => "retained history\npartial");
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    producer.reset();
    expect(producer.read(5)).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).toHaveBeenCalledExactlyOnceWith(["retained history", "partial"]);
    expect(producer.read(1)).toEqual(["partial"]);
    producer.stop();
  });

  it("reads rewritten current-execution fragments independently of deduplicated log batches", async () => {
    const capture = vi.fn(async () => "OLD_READY\nretained");
    const producer = new TmuxOutputProducer(capture, "%1", 100, ["OLD_READY", "retained"]);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    expect(producer.read(500)).toEqual([]);
    capture.mockResolvedValue("OLD_READY\nretained\nloading");
    await vi.advanceTimersByTimeAsync(100);
    expect(producer.read(500)).toEqual(["loading"]);
    const readiness = waitForReady({ output: /^READY$/ }, new AbortController().signal, {
      detectPorts: async () => [],
      readOutput: async (tail) => producer.read(tail).join("\n"),
    });
    capture.mockResolvedValue("OLD_READY\nretained\nREADY");
    await vi.advanceTimersByTimeAsync(100);
    expect(producer.read(500)).toEqual(["READY"]);
    expect(producer.snapshot()).toEqual(["OLD_READY", "retained", "READY"]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(readiness).resolves.toEqual([]);
    expect(listener).toHaveBeenCalledExactlyOnceWith(["loading"]);
    producer.stop();
  });

  it("reads a rewritten first partial line without accumulating its stale value", async () => {
    const capture = vi.fn(async () => "loading");
    const producer = new TmuxOutputProducer(capture, "%1", 100, []);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    capture.mockResolvedValue("READY");
    await vi.advanceTimersByTimeAsync(100);
    expect(producer.read(500)).toEqual(["READY"]);
    expect(listener).toHaveBeenCalledExactlyOnceWith(["loading"]);
    producer.stop();
  });

  it("flushes an in-flight batch once before removal", async () => {
    let finishCapture!: (value: string) => void;
    const capture = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    const flushing = producer.flush();
    finishCapture("last\nfragment");
    await flushing;
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledExactlyOnceWith(["last", "fragment"]);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("stops on capture errors and suppresses pending output after stop", async () => {
    const capture = vi.fn(async (): Promise<string> => {
      throw new Error("pane removed");
    });
    const producer = new TmuxOutputProducer(capture, "%1", 100);
    const listener = vi.fn();
    producer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    let finishCapture!: (value: string) => void;
    const pending = new TmuxOutputProducer(
      async () =>
        new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
      "%2",
      100,
    );
    pending.subscribe(listener);
    await vi.advanceTimersByTimeAsync(100);
    pending.stop();
    finishCapture("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
