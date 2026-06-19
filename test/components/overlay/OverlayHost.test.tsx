import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import type { OverlayApi } from "../../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";

const ESC = "\x1b";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

let captured: OverlayApi | undefined;

function Controller() {
  captured = useOverlay();
  return null;
}

function renderHost() {
  return render(
    <OverlayProvider>
      <Controller />
      <OverlayHost />
    </OverlayProvider>,
  );
}

const overlay = (id: string) => ({ id, render: () => <Text>{id}-body</Text> });

describe("OverlayHost", () => {
  it("renders nothing when the stack is empty", () => {
    const { lastFrame } = renderHost();
    expect(lastFrame()).toBe("");
  });

  it("renders only the top overlay when two are pushed", () => {
    const { lastFrame } = renderHost();
    act(() => captured?.push(overlay("first")));
    act(() => captured?.push(overlay("second")));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("second-body");
    expect(frame).not.toContain("first-body");
  });

  it("Esc pops overlays in LIFO order, revealing the one below", async () => {
    const { lastFrame, stdin } = renderHost();
    act(() => captured?.push(overlay("first")));
    act(() => captured?.push(overlay("second")));

    stdin.write(ESC);
    await flush();
    expect(lastFrame()).toContain("first-body");
    expect(lastFrame()).not.toContain("second-body");

    stdin.write(ESC);
    await flush();
    expect(lastFrame()).toBe("");
    expect(captured?.isOpen).toBe(false);
  });

  it("Esc is inert once the stack is empty", async () => {
    const { stdin } = renderHost();
    stdin.write(ESC);
    await flush();
    expect(captured?.isOpen).toBe(false);
    expect(captured?.stack).toHaveLength(0);
  });
});
