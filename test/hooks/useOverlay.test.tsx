import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";

let captured: OverlayApi | undefined;

function Probe() {
  captured = useOverlay();
  return <Text>depth:{captured.stack.length}</Text>;
}

const overlay = (id: string) => ({ id, render: () => <Text>{id}</Text> });

describe("useOverlay", () => {
  it("returns an inert API with no provider", () => {
    render(<Probe />);
    expect(captured?.isOpen).toBe(false);
    expect(captured?.stack).toHaveLength(0);
    // No-op push must not throw and must not open anything.
    act(() => captured?.push(overlay("a")));
    expect(captured?.isOpen).toBe(false);
  });

  it("pushes and pops in LIFO order, tracking top and isOpen", () => {
    render(
      <OverlayProvider>
        <Probe />
      </OverlayProvider>,
    );
    expect(captured?.isOpen).toBe(false);
    expect(captured?.top).toBeNull();

    act(() => captured?.push(overlay("a")));
    expect(captured?.isOpen).toBe(true);
    expect(captured?.top?.id).toBe("a");
    expect(captured?.isTop("a")).toBe(true);

    act(() => captured?.push(overlay("b")));
    expect(captured?.stack).toHaveLength(2);
    expect(captured?.top?.id).toBe("b");
    expect(captured?.isTop("b")).toBe(true);
    expect(captured?.isTop("a")).toBe(false);

    act(() => captured?.pop());
    expect(captured?.top?.id).toBe("a");

    act(() => captured?.pop());
    expect(captured?.isOpen).toBe(false);
    expect(captured?.top).toBeNull();
  });

  it("pop on an empty stack is a no-op", () => {
    render(
      <OverlayProvider>
        <Probe />
      </OverlayProvider>,
    );
    act(() => captured?.pop());
    expect(captured?.stack).toHaveLength(0);
  });

  it("re-pushing an existing id moves it to the top without duplicating", () => {
    render(
      <OverlayProvider>
        <Probe />
      </OverlayProvider>,
    );
    act(() => captured?.push(overlay("a")));
    act(() => captured?.push(overlay("b")));
    act(() => captured?.push(overlay("a")));
    expect(captured?.stack).toHaveLength(2);
    expect(captured?.top?.id).toBe("a");
  });
});
