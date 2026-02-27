import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogBuffer } from "../../src/daemon/log-buffer.js";

// Mock diffOutput to avoid importing the full manager
vi.mock("#src/lib/service/manager.js", () => ({
  diffOutput: (prev: string[], current: string[]) => {
    if (prev.length === 0) {
      return current.filter((l) => l !== "");
    }
    // Simple diff: find lines in current that are new
    const prevSet = new Set(prev);
    return current.filter((l) => l !== "" && !prevSet.has(l));
  },
}));

const { LogMonitor } = await import("../../src/daemon/log-monitor.js");

describe("LogMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const capturePane = vi.fn<(target: string, lines: number) => Promise<string>>();
    capturePane.mockResolvedValue("");
    const buffers = new Map([["api", new LogBuffer(100)]]);
    const listener = vi.fn();
    const monitor = new LogMonitor({ capturePane }, buffers, listener);
    return { capturePane, buffers, listener, monitor };
  }

  it("starts polling and appends new lines", async () => {
    const { capturePane, buffers, listener, monitor } = setup();
    capturePane.mockResolvedValueOnce("line1\nline2");

    monitor.start("api", "%1", 100);
    await vi.advanceTimersByTimeAsync(100);

    expect(capturePane).toHaveBeenCalledWith("%1", 500);
    expect(buffers.get("api")?.snapshot()).toContain("line1");
    expect(listener).toHaveBeenCalledWith("api", expect.arrayContaining(["line1", "line2"]));

    monitor.stopAll();
  });

  it("only reports new lines on subsequent polls", async () => {
    const { capturePane, listener, monitor } = setup();
    capturePane.mockResolvedValueOnce("line1\nline2");

    monitor.start("api", "%1", 100);
    await vi.advanceTimersByTimeAsync(100);

    listener.mockClear();
    capturePane.mockResolvedValueOnce("line1\nline2\nline3");
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).toHaveBeenCalledWith("api", ["line3"]);

    monitor.stopAll();
  });

  it("does not start duplicate monitoring", async () => {
    const { capturePane, monitor } = setup();
    monitor.start("api", "%1", 100);
    monitor.start("api", "%1", 100); // Should be no-op

    await vi.advanceTimersByTimeAsync(100);
    expect(capturePane).toHaveBeenCalledTimes(1);

    monitor.stopAll();
  });

  it("stop clears interval", async () => {
    const { capturePane, monitor } = setup();
    monitor.start("api", "%1", 100);
    monitor.stop("api");

    await vi.advanceTimersByTimeAsync(200);
    expect(capturePane).not.toHaveBeenCalled();
  });

  it("stopAll clears all intervals", async () => {
    const { capturePane } = setup();
    const buffers2 = new Map([
      ["api", new LogBuffer(100)],
      ["db", new LogBuffer(100)],
    ]);
    const monitor2 = new LogMonitor({ capturePane }, buffers2);
    monitor2.start("api", "%1", 100);
    monitor2.start("db", "%2", 100);
    monitor2.stopAll();

    await vi.advanceTimersByTimeAsync(200);
    expect(capturePane).not.toHaveBeenCalled();
  });

  it("guards against concurrent fetches", async () => {
    const { capturePane, monitor } = setup();
    let resolveCapture!: (value: string) => void;
    capturePane.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    monitor.start("api", "%1", 50);

    // First tick starts fetch
    await vi.advanceTimersByTimeAsync(50);
    expect(capturePane).toHaveBeenCalledTimes(1);

    // Second tick — fetch still in progress, should skip
    vi.advanceTimersByTime(50);
    expect(capturePane).toHaveBeenCalledTimes(1);

    // Resolve first fetch
    resolveCapture("line1");
    // Let promise chain resolve
    await vi.advanceTimersByTimeAsync(0);

    // Next tick — new fetch should start
    vi.advanceTimersByTime(50);
    expect(capturePane).toHaveBeenCalledTimes(2);

    monitor.stopAll();
  });

  it("does not call listener when no new lines", async () => {
    const { capturePane, listener, monitor } = setup();
    capturePane.mockResolvedValue("");

    monitor.start("api", "%1", 100);
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).not.toHaveBeenCalled();

    monitor.stopAll();
  });

  it("stop is no-op for non-monitored service", () => {
    const { monitor } = setup();
    // Should not throw
    monitor.stop("unknown");
  });

  it("start monitoring for service with no buffer does not crash", async () => {
    const capturePane = vi.fn<(target: string, lines: number) => Promise<string>>();
    capturePane.mockResolvedValueOnce("line1\nline2");
    const buffers = new Map<string, InstanceType<typeof LogBuffer>>();
    const listener = vi.fn();
    const monitor = new LogMonitor({ capturePane }, buffers, listener);

    monitor.start("missing", "%2", 100);
    await vi.advanceTimersByTimeAsync(100);

    // Listener still called with new lines even without a buffer
    expect(listener).toHaveBeenCalledWith("missing", expect.arrayContaining(["line1"]));

    monitor.stopAll();
  });
});
