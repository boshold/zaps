import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { LogView } from "../../src/components/LogView.js";

// Ink-testing-library provides a mock stdout without rows,
// So LogView falls back to 24. visibleLines = 24 - 4 = 20.
const VISIBLE_LINES = 20;

describe("LogView", () => {
  it("renders captured lines", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 1");
    expect(frame).toContain("line 2");
    expect(frame).toContain("line 3");
  });

  it("renders service name in header", () => {
    const { lastFrame } = render(
      <LogView serviceName="my-service" lines={[]} autoScroll offset={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("my-service");
  });

  it("auto-scroll shows latest lines within visible limit", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";

    // Should show last VISIBLE_LINES lines
    expect(frame).toContain(`line-${30 - 1}`);
    expect(frame).toContain(`line-${30 - VISIBLE_LINES}`);
    expect(frame).not.toContain(`line-${30 - VISIBLE_LINES - 1}`);
  });

  it("renders scroll help bar", () => {
    const { lastFrame } = render(<LogView serviceName="api" lines={[]} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[q/esc] back");
    expect(frame).toContain("scroll");
  });

  it("uses offset for manual scroll positioning", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const offset = 3;
    const { lastFrame } = render(
      <LogView serviceName="api" lines={lines} autoScroll={false} offset={offset} />,
    );
    const frame = lastFrame() ?? "";
    // Slice(-(20+3), -3) = slice(-23, -3) = lines 7..26
    expect(frame).toContain("line-7");
    expect(frame).toContain("line-26");
    expect(frame).not.toContain("line-29");
  });
});
