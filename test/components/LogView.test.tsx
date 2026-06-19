import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { LogView } from "../../src/components/LogView.js";

// No stdout rows from the harness → useDimensions falls back to 24, so the
// Measured log body is ~21 rows (24 − header − footer). Tests assert behavior
// (tail anchored, older hidden, fits the pane) rather than exact line counts.

describe("LogView", () => {
  it("renders captured lines that fit", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 1");
    expect(frame).toContain("line 2");
    expect(frame).toContain("line 3");
    // Everything fits → no overflow markers.
    expect(frame).not.toContain("more");
  });

  it("renders service name in header", () => {
    const { lastFrame } = render(
      <LogView serviceName="my-service" lines={[]} autoScroll offset={0} />,
    );
    expect(lastFrame()).toContain("my-service");
  });

  it("renders the scroll help footer", () => {
    const { lastFrame } = render(<LogView serviceName="api" lines={[]} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[esc] back");
    expect(frame).toContain("scroll");
  });

  it("shows a live autoscroll indicator when following", () => {
    const { lastFrame } = render(<LogView serviceName="api" lines={[]} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("live");
    expect(frame).not.toContain("paused");
  });

  it("shows a paused indicator when scrolled away from the tail", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(
      <LogView serviceName="api" lines={lines} autoScroll={false} offset={5} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("paused");
    expect(frame).not.toContain("live");
  });

  it("auto-scroll anchors the newest line at the tail and hides older lines", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";

    // Newest line visible; oldest hidden behind an up marker.
    expect(frame).toContain("line-59");
    expect(frame).not.toContain("line-0\n");
    expect(frame).toContain("↑");
    // Fits the pane.
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("manual scroll anchors offset lines back from the tail (newer lines hidden)", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const offset = 10;
    const { lastFrame } = render(
      <LogView serviceName="api" lines={lines} autoScroll={false} offset={offset} />,
    );
    const frame = lastFrame() ?? "";

    // Anchor = 59 − 10 = 49 is the bottom-most visible line; newer lines are hidden.
    expect(frame).toContain("line-49");
    expect(frame).not.toContain("line-59");
    expect(frame).not.toContain("line-50");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("manual scroll with offset=0 shows the latest line", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(
      <LogView serviceName="api" lines={lines} autoScroll={false} offset={0} />,
    );
    expect(lastFrame()).toContain("line-59");
  });
});
