import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { HelpBar } from "../../src/components/HelpBar.js";

describe("HelpBar", () => {
  it("renders shortcut hints", () => {
    const { lastFrame } = render(<HelpBar />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[r]estart");
    expect(frame).toContain("[s]top/start");
    expect(frame).toContain("[l]ogs");
    expect(frame).toContain("[o]pen");
    expect(frame).toContain("[t]asks");
    expect(frame).toContain("[a]ll restart");
    expect(frame).toContain("[q]uit");
  });
});
