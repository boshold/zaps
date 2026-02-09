import type { TaskConfig } from "../../src/config/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { TaskRow } from "../../src/components/TaskRow.js";

function makeTask(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    name: "Run migrations",
    commands: "pnpm db:migrate",
    ...overrides,
  };
}

describe("TaskRow", () => {
  it("renders pending state with circle icon", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("○");
    expect(frame).toContain("Run migrations");
  });

  it("renders running state with spinner icon", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={false} isRunning={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◐");
  });

  it("renders success state with checkmark icon", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={false} isRunning={false} result="success" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✔");
  });

  it("renders error state with cross icon", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={false} isRunning={false} result="error" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✖");
  });

  it("shows selection indicator when selected", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={true} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("does not show selection indicator when not selected", () => {
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={makeTask()} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    // Should have space, not >
    expect(frame).not.toMatch(/>\s+[○◐✔✖]/);
  });

  it("shows description when present", () => {
    const task = makeTask({ description: "Apply database schema changes" });
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={task} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Apply database schema changes");
  });

  it("does not render description separator when description is absent", () => {
    const task = makeTask({ description: undefined });
    const { lastFrame } = render(
      <TaskRow taskKey="migrate" task={task} isSelected={false} isRunning={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("—");
  });
});
