import { render } from "ink-testing-library";
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { FailedOutputBody } from "../../../src/components/overlay/FailedOutputBody.js";
import {
  FAILED_OUTPUT_ID,
  FailedOutputOverlay,
} from "../../../src/components/overlay/FailedOutputOverlay.js";
import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import type { TaskOutputSnapshot } from "../../../src/daemon/task-output-store.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";

// FailedOutputOverlay renders position="absolute" (uncapturable by
// Ink-testing-library), so its behavior is asserted via spies + the overlay
// Stack; the absolute-free FailedOutputBody is frame-tested directly.

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
};

async function press(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function snapshot(overrides: Partial<TaskOutputSnapshot> = {}): TaskOutputSnapshot {
  return {
    runId: "run_1",
    taskKey: "build",
    result: "error",
    lines: ["compiling…", "boom: failed"],
    startedAt: 0,
    endedAt: 1,
    ...overrides,
  };
}

interface OverlayProps {
  runId?: string;
  taskName?: string;
  fetchOutput: (runId: string) => Promise<TaskOutputSnapshot>;
  showPopup?: (title: string, lines: string[]) => Promise<void>;
  startInPopup?: boolean;
  onClose?: () => void;
}

function Pusher({ cfg }: { cfg: OverlayProps }) {
  const overlay = useOverlay();
  useEffect(() => {
    overlay.push({
      id: FAILED_OUTPUT_ID,
      render: () => (
        <FailedOutputOverlay
          runId={cfg.runId ?? "run_1"}
          taskName={cfg.taskName ?? "Build"}
          fetchOutput={cfg.fetchOutput}
          showPopup={cfg.showPopup}
          startInPopup={cfg.startInPopup}
          onClose={cfg.onClose ?? (() => undefined)}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push exactly once on mount
  }, []);
  return null;
}

function renderOverlay(cfg: OverlayProps) {
  return render(
    <OverlayProvider>
      <Pusher cfg={cfg} />
      <OverlayHost />
    </OverlayProvider>,
  );
}

describe("FailedOutputBody", () => {
  it("renders the fetched output lines", () => {
    const { lastFrame } = render(
      <FailedOutputBody
        taskName="Build"
        state="ready"
        lines={["compiling…", "boom: failed"]}
        selectedIndex={1}
        maxHeight={10}
        canEscalate
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Failed: Build");
    expect(frame).toContain("boom: failed");
    expect(frame).toContain("[p] popup");
  });

  it("shows an evicted message for not_found", () => {
    const { lastFrame } = render(
      <FailedOutputBody
        taskName="Build"
        state="not_found"
        lines={[]}
        selectedIndex={0}
        maxHeight={10}
        canEscalate={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no longer available");
    // No escalation offered when popup is unavailable.
    expect(frame).not.toContain("[p] popup");
  });

  it("shows a loading placeholder", () => {
    const { lastFrame } = render(
      <FailedOutputBody
        taskName="Build"
        state="loading"
        lines={[]}
        selectedIndex={0}
        maxHeight={10}
        canEscalate={false}
      />,
    );
    expect(lastFrame() ?? "").toContain("Loading output");
  });
});

describe("FailedOutputOverlay", () => {
  it("fetches the run output by runId on open", async () => {
    const fetchOutput = vi.fn(async () => snapshot());
    renderOverlay({ runId: "run_42", fetchOutput });
    await settle();
    expect(fetchOutput).toHaveBeenCalledWith("run_42");
  });

  it("acknowledges the sticky failure on Esc (close → onClose)", async () => {
    const onClose = vi.fn();
    const { stdin } = renderOverlay({ fetchOutput: async () => snapshot(), onClose });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    await press(stdin, "\x1B"); // Esc → OverlayHost pops → overlay unmounts → ack
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escalates to a popup on `p` with the prefixed title", async () => {
    const showPopup = vi.fn(async () => undefined);
    const { stdin } = renderOverlay({ fetchOutput: async () => snapshot(), showPopup });
    await settle();
    await press(stdin, "p");
    expect(showPopup).toHaveBeenCalledWith("Failed: Build", ["compiling…", "boom: failed"]);
  });

  it("does not re-fetch (or reset scroll) on a re-render with a stable fetchOutput", async () => {
    const fetchOutput = vi.fn(async () => snapshot());
    const cfg: OverlayProps = { fetchOutput };
    const { rerender } = render(
      <OverlayProvider>
        <Pusher cfg={cfg} />
        <OverlayHost />
      </OverlayProvider>,
    );
    await settle();
    expect(fetchOutput).toHaveBeenCalledTimes(1);
    // A re-render (what a terminal RESIZE triggers via OverlayHost) must not
    // Re-run the load effect — the fetcher identity is stable.
    rerender(
      <OverlayProvider>
        <Pusher cfg={cfg} />
        <OverlayHost />
      </OverlayProvider>,
    );
    await settle();
    expect(fetchOutput).toHaveBeenCalledTimes(1);
  });

  it("does not crash when the buffer was evicted (not_found)", async () => {
    const fetchOutput = vi.fn(async () => {
      throw new Error("not_found");
    });
    const onClose = vi.fn();
    const { stdin } = renderOverlay({ fetchOutput, onClose });
    await settle();
    expect(fetchOutput).toHaveBeenCalledTimes(1);
    // Still closeable + acks.
    await press(stdin, "\x1B");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("with startInPopup, escalates immediately then closes", async () => {
    const showPopup = vi.fn(async () => undefined);
    const onClose = vi.fn();
    renderOverlay({ fetchOutput: async () => snapshot(), showPopup, startInPopup: true, onClose });
    await settle();
    expect(showPopup).toHaveBeenCalledTimes(1);
    // Auto-escalation pops the overlay, which acks on unmount.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
