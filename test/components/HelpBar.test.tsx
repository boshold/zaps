import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { HelpBar } from "../../src/components/HelpBar.js";
import { getTaskShortcuts } from "../../src/lib/taskShortcuts.js";

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

  it("renders chord overlay when chordMode is true", () => {
    const shortcuts = [
      { shortcut: "p", name: "Prisma Push" },
      { shortcut: "i", name: "Prisma Import" },
    ];
    const { lastFrame } = render(<HelpBar chordMode taskShortcuts={shortcuts} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[p] Prisma Push");
    expect(frame).toContain("[i] Prisma Import");
    expect(frame).toContain("[enter] all tasks");
    expect(frame).toContain("[esc] back");
  });

  it("does not render global hints in chord mode", () => {
    const shortcuts = [{ shortcut: "p", name: "Push" }];
    const { lastFrame } = render(<HelpBar chordMode taskShortcuts={shortcuts} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[t]asks");
    expect(frame).not.toContain("[q]uit");
  });
});

describe("getTaskShortcuts", () => {
  it("uses explicit shortcut from config", () => {
    const tasks = {
      push: { name: "Prisma Push", commands: "pnpm db:push", shortcut: "p" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toEqual([{ shortcut: "p", name: "Prisma Push" }]);
  });

  it("auto-assigns first unique char when no shortcut", () => {
    const tasks = {
      migrate: { name: "Migrate", commands: "pnpm migrate" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toEqual([{ shortcut: "m", name: "Migrate" }]);
  });

  it("skips duplicate shortcuts", () => {
    const tasks = {
      push: { name: "Push", commands: "cmd", shortcut: "p" },
      pull: { name: "Pull", commands: "cmd", shortcut: "p" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Push");
  });

  it("auto-assigns skipping already-used chars", () => {
    const tasks = {
      push: { name: "Push", commands: "cmd", shortcut: "p" },
      pull: { name: "Pull", commands: "cmd" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toHaveLength(2);
    expect(result[1].shortcut).toBe("u"); // 'p' taken, next unique char from "pull" is 'u'
  });
});
