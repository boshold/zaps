import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installResizeReset, needsHardClear } from "../../src/lib/screen-reset.js";

const HARD_CLEAR = "\x1b[2J\x1b[3J\x1b[H";

describe("needsHardClear", () => {
  it("skips a width decrease (Ink clears that itself)", () => {
    expect(needsHardClear({ cols: 120, rows: 40 }, { cols: 80, rows: 40 })).toBe(false);
  });

  it("clears on a width grow (Ink leaves residue)", () => {
    expect(needsHardClear({ cols: 80, rows: 40 }, { cols: 120, rows: 40 })).toBe(true);
  });

  it("clears on a height-only change at the same width", () => {
    expect(needsHardClear({ cols: 80, rows: 24 }, { cols: 80, rows: 40 })).toBe(true);
    expect(needsHardClear({ cols: 80, rows: 40 }, { cols: 80, rows: 24 })).toBe(true);
  });

  it("does not clear when nothing changed", () => {
    expect(needsHardClear({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
  });

  it("skips a width decrease even when height also grows", () => {
    expect(needsHardClear({ cols: 120, rows: 24 }, { cols: 80, rows: 60 })).toBe(false);
  });
});

interface FakeStdout {
  isTTY: boolean;
  columns: number;
  rows: number;
  writes: string[];
  emitResize(cols: number, rows: number): void;
}

function makeStdout(opts: { isTTY: boolean; cols: number; rows: number }): {
  stream: NodeJS.WriteStream;
  state: FakeStdout;
} {
  const writes: string[] = [];
  // Live, mutable props on the emitter itself — Object.assign with getters would
  // Snapshot them once, defeating the resize reads.
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & FakeStdout;
  stream.isTTY = opts.isTTY;
  stream.columns = opts.cols;
  stream.rows = opts.rows;
  stream.writes = writes;
  stream.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as NodeJS.WriteStream["write"];
  stream.emitResize = (cols, rows) => {
    stream.columns = cols;
    stream.rows = rows;
    stream.emit("resize");
  };
  return { stream, state: stream };
}

describe("installResizeReset", () => {
  it("hard-clears on a width grow", () => {
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    installResizeReset(stream);

    state.emitResize(120, 40);

    expect(state.writes).toEqual([HARD_CLEAR]);
  });

  it("stays quiet on a width shrink", () => {
    const { stream, state } = makeStdout({ isTTY: true, cols: 120, rows: 40 });
    installResizeReset(stream);

    state.emitResize(80, 40);

    expect(state.writes).toEqual([]);
  });

  it("tracks size across successive resizes", () => {
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    installResizeReset(stream);

    state.emitResize(120, 40); // Grow → clear
    state.emitResize(60, 40); // Shrink → quiet, but updates baseline
    state.emitResize(80, 40); // Grow from 60 → clear

    expect(state.writes).toEqual([HARD_CLEAR, HARD_CLEAR]);
  });

  it("unsubscribes so later resizes are ignored", () => {
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    const stop = installResizeReset(stream);

    stop();
    state.emitResize(120, 40);

    expect(state.writes).toEqual([]);
  });

  it("is a no-op on a non-TTY stream", () => {
    const { stream, state } = makeStdout({ isTTY: false, cols: 80, rows: 40 });
    const stop = installResizeReset(stream);

    state.emitResize(120, 40);
    stop();

    expect(state.writes).toEqual([]);
  });
});

describe("installResizeReset warm-up poll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hard-clears on a poll-detected grow with no resize event", () => {
    vi.useFakeTimers();
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    installResizeReset(stream);

    // Settle wider without emitting a resize event — only the poll can catch it.
    state.columns = 120;
    vi.advanceTimersByTime(100);

    expect(state.writes).toEqual([HARD_CLEAR]);
  });

  it("stops polling after the warm-up window", () => {
    vi.useFakeTimers();
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    installResizeReset(stream);

    vi.advanceTimersByTime(2000); // Run past the warm-up (15 * 100ms).
    state.columns = 200;
    vi.advanceTimersByTime(2000);

    expect(state.writes).toEqual([]);
  });

  it("clears the warm-up interval on unsubscribe", () => {
    vi.useFakeTimers();
    const { stream, state } = makeStdout({ isTTY: true, cols: 80, rows: 40 });
    const stop = installResizeReset(stream);

    stop();
    state.columns = 120;
    vi.advanceTimersByTime(2000);

    expect(state.writes).toEqual([]);
  });
});
