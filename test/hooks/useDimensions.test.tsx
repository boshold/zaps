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
});
