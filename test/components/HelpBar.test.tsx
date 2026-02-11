import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { HelpBar } from "../../src/components/HelpBar.js";

describe("HelpBar", () => {
  it("renders global shortcut hints only", () => {
    const { lastFrame } = render(<HelpBar />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[t]asks");
    expect(frame).toContain("[a]ll restart");
    expect(frame).toContain("[q]uit");
  });

  it("does not render per-service shortcuts", () => {
    const { lastFrame } = render(<HelpBar />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[r]estart");
    expect(frame).not.toContain("[l]ogs");
    expect(frame).not.toContain("[o]pen");
  });
});
