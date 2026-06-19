import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { TaskPickerBody } from "../../../src/components/overlay/TaskPickerBody.js";
import type { UiTaskMode } from "../../../src/config/types.js";
import type { TaskInfo } from "../../../src/daemon/session.js";

// `TaskPicker` wraps the body in a position="absolute" box; the body holds all
// Behavior and is absolute-free, so it is tested directly here (mirrors the
// CommandPaletteBody test).

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

function makeTasks(): TaskInfo[] {
  return [
    { key: "migrate", name: "Migrate DB", description: null, shortcut: "m" },
    { key: "seed", name: "Seed database", description: null },
    { key: "build", name: "Build app", description: null },
  ];
}

async function type(stdin: { write: (s: string) => void }, text: string) {
  for (const ch of text) {
    stdin.write(ch);
    // Flush between keystrokes so each lands against a committed render.
    await flush();
  }
}

function renderBody(opts: {
  tasks?: TaskInfo[];
  runningKeys?: Set<string>;
  defaultMode?: UiTaskMode;
  isActive?: boolean;
}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  const result = render(
    <TaskPickerBody
      tasks={opts.tasks ?? makeTasks()}
      runningKeys={opts.runningKeys ?? new Set()}
      defaultMode={opts.defaultMode ?? "background"}
      isActive={opts.isActive ?? true}
      onClose={onClose}
      onRun={onRun}
    />,
  );
  return { ...result, onRun, onClose };
}

describe("TaskPickerBody", () => {
  it("lists all tasks on open (empty query) with the filter prompt", () => {
    const { lastFrame } = renderBody({});
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Migrate DB");
    expect(frame).toContain("Seed database");
    expect(frame).toContain("Build app");
    expect(frame).toContain("Type to filter tasks");
  });

  it("shows each task's shortcut as a hint", () => {
    const { lastFrame } = renderBody({});
    expect(lastFrame() ?? "").toContain("m");
  });

  it("fuzzy-filters the list as the user types", async () => {
    const { stdin, lastFrame } = renderBody({});
    await type(stdin, "migr");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Migrate DB");
    expect(frame).not.toContain("Seed database");
    expect(frame).not.toContain("Build app");
  });

  it("runs the highlighted task in the default (background) mode on Enter and closes", async () => {
    const { stdin, onRun, onClose } = renderBody({ defaultMode: "background" });
    await type(stdin, "migr");
    stdin.write("\r");
    await flush();
    expect(onRun).toHaveBeenCalledWith("migrate", "background");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs in a pane on Enter when the default mode is pane", async () => {
    const { stdin, onRun } = renderBody({ defaultMode: "pane" });
    await type(stdin, "migr");
    stdin.write("\r");
    await flush();
    expect(onRun).toHaveBeenCalledWith("migrate", "pane");
  });

  it("runs the highlighted task in a pane on Tab regardless of default mode", async () => {
    const { stdin, onRun, onClose } = renderBody({ defaultMode: "background" });
    await type(stdin, "migr");
    stdin.write("\t");
    await flush();
    expect(onRun).toHaveBeenCalledWith("migrate", "pane");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-filter message when nothing matches", async () => {
    const { stdin, lastFrame } = renderBody({});
    await type(stdin, "zzzzz");
    expect(lastFrame() ?? "").toContain("No matches for 'zzzzz'");
  });

  it("shows a no-tasks message when there are no tasks", () => {
    const { lastFrame } = renderBody({ tasks: [] });
    expect(lastFrame() ?? "").toContain("No tasks defined");
  });

  it("guards a duplicate launch (Q12): surfaces 'already running' and does not run", async () => {
    const { stdin, lastFrame, onRun, onClose } = renderBody({
      runningKeys: new Set(["migrate"]),
    });
    await type(stdin, "migr");
    stdin.write("\r");
    await flush();
    expect(lastFrame() ?? "").toContain("already running");
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not bind Esc (OverlayHost owns Esc→pop)", async () => {
    const { stdin, onClose } = renderBody({});
    stdin.write("\x1B");
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores input while inactive", async () => {
    const { stdin, lastFrame, onRun } = renderBody({ isActive: false });
    await type(stdin, "migr");
    stdin.write("\r");
    await flush();
    // No filtering happened and Enter did nothing.
    expect(lastFrame() ?? "").toContain("Seed database");
    expect(onRun).not.toHaveBeenCalled();
  });
});
