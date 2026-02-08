import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { useLogs } from "../../src/hooks/useLogs.js";

// Mock tmux.capturePane
vi.mock("../../src/lib/tmux.js", () => ({
  capturePane: vi.fn().mockResolvedValue("line1\nline2\nline3"),
}));

import { capturePane } from "../../src/lib/tmux.js";

const mockCapturePane = capturePane as ReturnType<typeof vi.fn>;

// Flush React/Ink reconciler
function act(fn: () => void): Promise<void> {
  fn();
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("useLogs", () => {
  it("returns empty lines when paneTarget is null", () => {
    function Wrapper() {
      const { lines } = useLogs(null);
      return <Text>count:{lines.length}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("count:0");
  });

  it("scrollUp sets autoScroll to false and increments offset", async () => {
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    expect(lastFrame()).toContain("autoScroll:true");
    expect(lastFrame()).toContain("offset:0");

    await act(() => { hookRef!.scrollUp(); });
    expect(lastFrame()).toContain("autoScroll:false");
    expect(lastFrame()).toContain("offset:1");

    await act(() => { hookRef!.scrollUp(); });
    expect(lastFrame()).toContain("offset:2");
  });

  it("scrollDown decrements offset and re-enables autoScroll at 0", async () => {
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    // Scroll up twice
    await act(() => { hookRef!.scrollUp(); });
    await act(() => { hookRef!.scrollUp(); });
    expect(lastFrame()).toContain("offset:2");
    expect(lastFrame()).toContain("autoScroll:false");

    // Scroll down once
    await act(() => { hookRef!.scrollDown(); });
    expect(lastFrame()).toContain("offset:1");
    expect(lastFrame()).toContain("autoScroll:false");

    // Scroll down to 0 -> autoScroll re-enabled
    await act(() => { hookRef!.scrollDown(); });
    expect(lastFrame()).toContain("offset:0");
    expect(lastFrame()).toContain("autoScroll:true");
  });

  it("resetScroll sets offset to 0 and autoScroll to true", async () => {
    let hookRef: ReturnType<typeof useLogs> | null = null;

    function Wrapper() {
      hookRef = useLogs(null);
      return (
        <>
          <Text>autoScroll:{String(hookRef.autoScroll)}</Text>
          <Text>offset:{hookRef.offset}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    // Scroll up
    await act(() => { hookRef!.scrollUp(); });
    await act(() => { hookRef!.scrollUp(); });
    expect(lastFrame()).toContain("offset:2");

    // Reset
    await act(() => { hookRef!.resetScroll(); });
    expect(lastFrame()).toContain("offset:0");
    expect(lastFrame()).toContain("autoScroll:true");
  });
});

// Separate describe for tests needing fake timers — ensures cleanup via afterEach
describe("useLogs polling", () => {
  it("polls capturePane at interval and returns lines", async () => {
    vi.useFakeTimers();
    mockCapturePane.mockClear();
    mockCapturePane.mockResolvedValue("line1\nline2\nline3");

    try {
      function Wrapper() {
        const { lines } = useLogs("%test");
        return <Text>lines:{lines.join("|")}</Text>;
      }

      const { lastFrame, unmount } = render(<Wrapper />);

      // Initially empty
      expect(lastFrame()).toContain("lines:");

      // Advance past first interval (500ms)
      await vi.advanceTimersByTimeAsync(600);
      // Allow the async capturePane mock to resolve and React to re-render
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(mockCapturePane).toHaveBeenCalledWith("%test", 200);
      expect(lastFrame()).toContain("line1|line2|line3");

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when unmounted", async () => {
    vi.useFakeTimers();
    mockCapturePane.mockClear();
    mockCapturePane.mockResolvedValue("line1\nline2\nline3");

    try {
      function Wrapper() {
        const { lines } = useLogs("%test");
        return <Text>lines:{lines.length}</Text>;
      }

      const { unmount } = render(<Wrapper />);

      // First poll
      await vi.advanceTimersByTimeAsync(600);
      const callCount = mockCapturePane.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(1);

      unmount();
      mockCapturePane.mockClear();

      // Advance more — should not poll anymore
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockCapturePane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
