import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { HelpBar } from "../../src/components/HelpBar.js";

describe("HelpBar", () => {
  it("renders shortcut hints", () => {
    const { lastFrame } = render(<HelpBar />);
    expect(lastFrame()).toContain("[t]asks");
    expect(lastFrame()).toContain("[a]ll restart");
    expect(lastFrame()).toContain("[q]uit");
  });
});
