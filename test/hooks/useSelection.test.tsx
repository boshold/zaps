import { Text } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useSelection } from "../../src/hooks/useSelection.js";

// Flush React/Ink reconciler — 50ms is enough for batched updates to process
function act(fn: () => void): Promise<void> {
  fn();
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("useSelection", () => {
  it("starts at index 0", () => {
    function Wrapper() {
      const { index } = useSelection(5);
      return <Text>index:{index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("index:0");
  });

  it("moveDown increments index", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;

    function Wrapper() {
      hookRef = useSelection(5);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:1");

    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:2");
  });

  it("moveDown clamps at last index", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;

    function Wrapper() {
      hookRef = useSelection(3);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(() => { hookRef!.moveDown(); });
    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:2");

    // Past the end
    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:2");
  });

  it("moveUp decrements index", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;

    function Wrapper() {
      hookRef = useSelection(5);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(() => { hookRef!.moveDown(); });
    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:2");

    await act(() => { hookRef!.moveUp(); });
    expect(lastFrame()).toContain("index:1");
  });

  it("moveUp clamps at 0", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;

    function Wrapper() {
      hookRef = useSelection(3);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("index:0");

    await act(() => { hookRef!.moveUp(); });
    expect(lastFrame()).toContain("index:0");
  });

  it("clamps index when itemCount decreases", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;
    let setCount: ((n: number) => void) | null = null;

    function Wrapper() {
      const [count, _setCount] = useState(5);
      setCount = _setCount;
      hookRef = useSelection(count);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    // Move to index 4
    await act(() => { hookRef!.moveDown(); });
    await act(() => { hookRef!.moveDown(); });
    await act(() => { hookRef!.moveDown(); });
    await act(() => { hookRef!.moveDown(); });
    expect(lastFrame()).toContain("index:4");

    // Reduce itemCount to 2 -> index should clamp to 1
    // setCount re-renders, then useEffect fires setIndex clamp
    await act(() => { setCount!(2); });
    // Extra wait for useEffect -> second setState
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(lastFrame()).toContain("index:1");
  });

  it("handles itemCount of 0 gracefully", () => {
    function Wrapper() {
      const { index } = useSelection(0);
      return <Text>index:{index}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("index:0");
  });
});
