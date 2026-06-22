import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal stdout stub the hook can subscribe to. Shared across renders so a test
// Can flip the dimensions and fire a "resize" the way a real terminal would.
const fakeStdout = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    columns: 80,
    rows: 24,
    on(event: string, fn: () => void) {
      if (event === "resize") {
        listeners.add(fn);
      }
    },
    off(event: string, fn: () => void) {
      if (event === "resize") {
        listeners.delete(fn);
      }
    },
    emitResize() {
      for (const fn of listeners) {
        fn();
      }
    },
    listenerCount() {
      return listeners.size;
    },
    clearListeners() {
      listeners.clear();
    },
  };
});

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return { ...actual, useStdout: () => ({ stdout: fakeStdout }) };
});

const { useDimensions } = await import("../../src/hooks/useDimensions.js");

function Probe() {
  const d = useDimensions();
  return (
    <Text>{`${d.cols}x${d.rows} compact=${d.compact} narrow=${d.narrow} medium=${d.medium}`}</Text>
  );
}

describe("useDimensions", () => {
  beforeEach(() => {
    fakeStdout.columns = 80;
    fakeStdout.rows = 24;
    fakeStdout.clearListeners();
  });

  it("reads the initial size from stdout", () => {
    fakeStdout.columns = 120;
    fakeStdout.rows = 40;
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("120x40");
  });

  it("falls back to 80x24 when stdout has no dimensions", () => {
    fakeStdout.columns = undefined as unknown as number;
    fakeStdout.rows = undefined as unknown as number;
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("80x24");
  });

  it("updates state when stdout emits a resize (F11)", () => {
    fakeStdout.columns = 100;
    fakeStdout.rows = 30;
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("100x30");

    act(() => {
      fakeStdout.columns = 40;
      fakeStdout.rows = 10;
      fakeStdout.emitResize();
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("40x10");
    // Rows < 12 -> compact, cols < 50 -> narrow, cols < 120 -> medium
    expect(frame).toContain("compact=true");
    expect(frame).toContain("narrow=true");
    expect(frame).toContain("medium=true");
  });

  it("recomputes breakpoints when growing back to a full layout (F11)", () => {
    fakeStdout.columns = 40;
    fakeStdout.rows = 10;
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("compact=true");

    act(() => {
      fakeStdout.columns = 160;
      fakeStdout.rows = 50;
      fakeStdout.emitResize();
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("160x50");
    expect(frame).toContain("compact=false");
    expect(frame).toContain("narrow=false");
    expect(frame).toContain("medium=false");
  });

  it("unsubscribes the resize listener on unmount", () => {
    const { unmount } = render(<Probe />);
    expect(fakeStdout.listenerCount()).toBe(1);
    unmount();
    expect(fakeStdout.listenerCount()).toBe(0);
  });

  it("converges to the real size via the warm-up poll when the resize event is missed", () => {
    vi.useFakeTimers();
    try {
      // Mount at a transient startup size, the way a mid-split pane would seed.
      fakeStdout.columns = 105;
      fakeStdout.rows = 18;
      const { lastFrame } = render(<Probe />);
      expect(lastFrame()).toContain("105x18");

      // Pane settles wider but NO resize event reaches the listener (the
      // Startup race). The warm-up poll must still pick up the new size.
      act(() => {
        fakeStdout.columns = 152;
        fakeStdout.rows = 18;
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(lastFrame()).toContain("152x18");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling after the warm-up window", () => {
    vi.useFakeTimers();
    try {
      fakeStdout.columns = 100;
      fakeStdout.rows = 30;
      const { lastFrame } = render(<Probe />);

      // Run out the warm-up window (15 ticks * 100ms), then change size with no
      // Event: the poll is gone, so the frame must stay put.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      act(() => {
        fakeStdout.columns = 200;
        fakeStdout.rows = 50;
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(lastFrame()).toContain("100x30");

      // The steady-state resize listener still works after warm-up.
      act(() => {
        fakeStdout.emitResize();
      });
      expect(lastFrame()).toContain("200x50");
    } finally {
      vi.useRealTimers();
    }
  });
});
