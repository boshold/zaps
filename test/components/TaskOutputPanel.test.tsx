import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { TaskOutputPanel } from "../../src/components/TaskOutputPanel.js";

describe("TaskOutputPanel", () => {
  it("renders lines", () => {
    const { lastFrame } = render(
      <TaskOutputPanel lines={["hello", "world"]} visibleLines={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toContain("world");
  });

  it("strips ANSI escape sequences", () => {
    const { lastFrame } = render(
      <TaskOutputPanel lines={["\x1b[31mred text\x1b[0m"]} visibleLines={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("red text");
    expect(frame).not.toContain("\x1b[31m");
  });

  it("replaces non-printable chars with spaces", () => {
    const { lastFrame } = render(
      <TaskOutputPanel lines={["hello\x01world"]} visibleLines={10} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello world");
  });

  it("limits visible lines from the end", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const { lastFrame } = render(
      <TaskOutputPanel lines={lines} visibleLines={2} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("d");
    expect(frame).toContain("e");
    expect(frame).not.toContain("a");
  });
});
