import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { LogView } from "../../src/components/LogView.js";

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

  it("shows correct number of visible lines based on terminal height", () => {
    // Override stdout.rows for this test
    const original = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 10, writable: true });

    // VisibleLines = 10 - 4 = 6
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";

    // With autoScroll, should show last 6 lines (line-14 through line-19)
    expect(frame).toContain("line-19");
    expect(frame).toContain("line-14");
    expect(frame).not.toContain("line-13");

    Object.defineProperty(process.stdout, "rows", { value: original, writable: true });
  });

  it("auto-scroll shows latest lines", () => {
    const original = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 10, writable: true });

    const lines = Array.from({ length: 20 }, (_, i) => `log-${i}`);
    const { lastFrame } = render(<LogView serviceName="api" lines={lines} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("log-19");
    expect(frame).not.toContain("log-0");

    Object.defineProperty(process.stdout, "rows", { value: original, writable: true });
  });

  it("renders scroll help bar", () => {
    const { lastFrame } = render(<LogView serviceName="api" lines={[]} autoScroll offset={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[esc] back");
    expect(frame).toContain("scroll");
  });

  it("uses offset for manual scroll positioning", () => {
    const original = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 10, writable: true });

    // VisibleLines = 6
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    // AutoScroll off, offset=3 should show lines further back
    const { lastFrame } = render(
      <LogView serviceName="api" lines={lines} autoScroll={false} offset={3} />,
    );
    const frame = lastFrame() ?? "";
    // Slice(-(6+3), -3) = slice(-9, -3) = lines 11..16
    expect(frame).toContain("line-11");
    expect(frame).toContain("line-16");
    expect(frame).not.toContain("line-19");

    Object.defineProperty(process.stdout, "rows", { value: original, writable: true });
  });
});
