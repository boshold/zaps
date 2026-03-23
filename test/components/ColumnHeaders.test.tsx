import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ColumnHeaders } from "../../src/components/ColumnHeaders.js";

describe("ColumnHeaders", () => {
  it("renders wide layout (cols >= 80) with NAME STATUS PORTS URL", () => {
    const { lastFrame } = render(<ColumnHeaders cols={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAME");
    expect(frame).toContain("STATUS");
    expect(frame).toContain("PORTS");
    expect(frame).toContain("URL");
  });

  it("renders medium layout (cols >= 50 < 80) with NAME STATUS PORTS", () => {
    const { lastFrame } = render(<ColumnHeaders cols={60} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAME");
    expect(frame).toContain("STATUS");
    expect(frame).toContain("PORTS");
    expect(frame).not.toContain("URL");
  });

  it("renders narrow layout (cols >= 30 < 50) with NAME STATUS", () => {
    const { lastFrame } = render(<ColumnHeaders cols={40} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAME");
    expect(frame).toContain("STATUS");
    expect(frame).not.toContain("PORTS");
  });

  it("renders tiny layout (cols < 30) with NAME only", () => {
    const { lastFrame } = render(<ColumnHeaders cols={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAME");
    expect(frame).not.toContain("STATUS");
  });
});
