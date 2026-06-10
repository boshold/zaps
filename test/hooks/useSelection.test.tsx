import { Text } from "ink";
import { render } from "ink-testing-library";
import { act, useState } from "react";
import { describe, expect, it } from "vitest";

import { useSelection } from "../../src/hooks/useSelection.js";

function renderSelection(itemCount: number) {
  let hookRef: ReturnType<typeof useSelection> | null = null;

  function TestWrapper() {
    hookRef = useSelection(itemCount);
    return <Text>index:{hookRef.index}</Text>;
  }

  const result = render(<TestWrapper />);
  return { ...result, hookRef: () => hookRef! };
}

describe("useSelection", () => {
  it("starts at index 0", () => {
    const { lastFrame } = renderSelection(5);
    expect(lastFrame()).toContain("index:0");
  });

  it("moveDown increments index", async () => {
    const { lastFrame, hookRef } = renderSelection(5);

    act(() => {
      hookRef().moveDown();
    });
    expect(lastFrame()).toContain("index:1");

    act(() => {
      hookRef().moveDown();
    });
    expect(lastFrame()).toContain("index:2");
  });

  it("moveDown clamps at last index", async () => {
    const { lastFrame, hookRef } = renderSelection(3);

    act(() => {
      hookRef().moveDown();
    });
    act(() => {
      hookRef().moveDown();
    });
    expect(lastFrame()).toContain("index:2");

    // Past the end
    act(() => {
      hookRef().moveDown();
    });
    expect(lastFrame()).toContain("index:2");
  });

  it("moveUp decrements index", async () => {
    const { lastFrame, hookRef } = renderSelection(5);

    act(() => {
      hookRef().moveDown();
    });
    act(() => {
      hookRef().moveDown();
    });
    expect(lastFrame()).toContain("index:2");

    act(() => {
      hookRef().moveUp();
    });
    expect(lastFrame()).toContain("index:1");
  });

  it("moveUp clamps at 0", async () => {
    const { lastFrame, hookRef } = renderSelection(3);
    expect(lastFrame()).toContain("index:0");

    act(() => {
      hookRef().moveUp();
    });
    expect(lastFrame()).toContain("index:0");
  });

  it("clamps index when itemCount decreases", async () => {
    let hookRef: ReturnType<typeof useSelection> | null = null;
    let setCountExternal: ((n: number) => void) | null = null;

    function TestWrapper() {
      const [count, setCount] = useState(5);
      setCountExternal = setCount;
      hookRef = useSelection(count);
      return <Text>index:{hookRef.index}</Text>;
    }

    const { lastFrame } = render(<TestWrapper />);

    // Move to index 4
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        hookRef?.moveDown();
      });
    }
    expect(lastFrame()).toContain("index:4");

    // Reduce itemCount to 2 -> index should clamp to 1
    // SetCount re-renders, then useEffect fires setIndex clamp
    act(() => {
      setCountExternal?.(2);
    });
    // Flush useEffect -> second setState
    await act(async () => {
      /* Flush */
    });
    expect(lastFrame()).toContain("index:1");
  });

  it("setIndex sets index directly", async () => {
    const { lastFrame, hookRef } = renderSelection(5);

    act(() => {
      hookRef().setIndex(3);
    });
    expect(lastFrame()).toContain("index:3");
  });

  it("handles itemCount of 0 gracefully", () => {
    function TestWrapper() {
      const { index } = useSelection(0);
      return <Text>index:{index}</Text>;
    }

    const { lastFrame } = render(<TestWrapper />);
    expect(lastFrame()).toContain("index:0");
  });
});
