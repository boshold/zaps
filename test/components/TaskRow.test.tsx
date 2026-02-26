import type { TaskInfo } from "../../src/daemon/session.js";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { TaskRow } from "../../src/components/TaskRow.js";

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    key: "migrate",
    name: "Run migrations",
    description: null,
    ...overrides,
  };
}

describe("TaskRow", () => {
  it("renders pending state with circle icon", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("○");
    expect(frame).toContain("Run migrations");
  });

  it("renders running state with spinner icon", () => {
    const { lastFrame } = render(<TaskRow task={makeTask()} isSelected={false} isRunning />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◐");
  });

  it("renders success state with checkmark icon", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} result="success" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✔");
  });

  it("renders error state with cross icon", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} result="error" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✖");
  });

  it("shows selection indicator when selected", () => {
    const { lastFrame } = render(<TaskRow task={makeTask()} isSelected isRunning={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("does not show selection indicator when not selected", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    // Should have space, not >
    expect(frame).not.toMatch(/>\s+[○◐✔✖]/);
  });

  it("shows description when present", () => {
    const task = makeTask({ description: "Apply database schema changes" });
    const { lastFrame } = render(<TaskRow task={task} isSelected={false} isRunning={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Apply database schema changes");
  });

  it("does not render description separator when description is absent", () => {
    const task = makeTask();
    const { lastFrame } = render(<TaskRow task={task} isSelected={false} isRunning={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("—");
  });

  it("renders shortcut badge when shortcut is provided", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} shortcut="m" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[m]");
  });

  it("does not render shortcut badge when shortcut is absent", () => {
    const { lastFrame } = render(
      <TaskRow task={makeTask()} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/\[\w\]/);
  });
});
