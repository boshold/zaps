import { render } from "ink-testing-library";
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import { StartServicesBody } from "../../../src/components/overlay/StartServicesBody.js";
import type { StartServicesEntry } from "../../../src/components/overlay/StartServicesBody.js";
import {
  START_SERVICES_ID,
  StartServicesOverlay,
} from "../../../src/components/overlay/StartServicesOverlay.js";
import type { OverlayApi } from "../../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";

const services: StartServicesEntry[] = [
  { name: "db", state: "stopped", required: false },
  { name: "api", state: "error", required: true },
];

async function press(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

let captured: OverlayApi | undefined;

function Pusher({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const overlay = useOverlay();
  captured = overlay;
  useEffect(() => {
    overlay.push({
      id: START_SERVICES_ID,
      render: () => (
        <StartServicesOverlay
          taskName="Verify mail"
          services={services}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push exactly once on mount
  }, []);
  return null;
}

function renderOverlay() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <OverlayProvider>
      <Pusher onConfirm={onConfirm} onCancel={onCancel} />
      <OverlayHost />
    </OverlayProvider>,
  );
  return { ...result, onConfirm, onCancel };
}

describe("StartServicesBody", () => {
  it("lists services with text states, marks dependencies and shows the hint", () => {
    const { lastFrame } = render(<StartServicesBody taskName="Verify mail" services={services} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Start services for Verify mail?");
    expect(frame).toContain("db (stopped) (dependency)");
    expect(frame).toContain("api (error)");
    expect(frame).not.toContain("api (error) (dependency)");
    expect(frame).toContain("y start · n cancel");
  });
});

describe("StartServicesOverlay", () => {
  it.each(["y", "Y", "\r"])("confirms on %j", async (key) => {
    const { stdin, onConfirm, onCancel } = renderOverlay();
    await press(stdin, "j");
    expect(captured?.top?.id).toBe(START_SERVICES_ID);
    await press(stdin, key);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(captured?.isOpen).toBe(false);
  });

  it.each(["n", "N", "\x1b"])("cancels once on %j", async (key) => {
    const { stdin, onConfirm, onCancel } = renderOverlay();
    await press(stdin, "j");
    await press(stdin, key);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(captured?.isOpen).toBe(false);
  });

  it("ignores other keys", async () => {
    const { stdin, onConfirm, onCancel } = renderOverlay();
    await press(stdin, "j");
    await press(stdin, "x");
    expect(captured?.top?.id).toBe(START_SERVICES_ID);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels when the stack is cleared", async () => {
    const { stdin, onCancel } = renderOverlay();
    await press(stdin, "j");
    expect(captured?.top?.id).toBe(START_SERVICES_ID);
    act(() => captured?.clear());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
