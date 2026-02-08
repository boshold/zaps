import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { Header } from "../../src/components/Header.js";

describe("Header", () => {
  it("renders project name", () => {
    const { lastFrame } = render(<Header projectName="my-project" />);
    expect(lastFrame()).toContain("zaps:");
    expect(lastFrame()).toContain("my-project");
  });

  it("renders separator line", () => {
    const { lastFrame } = render(<Header projectName="test" />);
    expect(lastFrame()).toContain("─");
  });
});
