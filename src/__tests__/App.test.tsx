import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../components/App.js";

describe("App", () => {
  it("renders welcome text", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain("zaps");
    expect(lastFrame()).toContain("Terminal session manager");
  });
});
