import type { TaskConfig } from "../../src/config/types.js";
import { describe, expect, it } from "vitest";

import { getTaskShortcuts } from "../../src/lib/taskShortcuts.js";

describe("getTaskShortcuts", () => {
  it("uses explicit shortcut when provided", () => {
    const tasks: Record<string, TaskConfig> = {
      build: { name: "Build", commands: "build", shortcut: "b" },
    };
    expect(getTaskShortcuts(tasks)).toEqual([{ shortcut: "b", name: "Build" }]);
  });

  it("auto-assigns first unique char from key", () => {
    const tasks: Record<string, TaskConfig> = {
      build: { name: "Build", commands: "build" },
      test: { name: "Test", commands: "test" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toEqual([
      { shortcut: "b", name: "Build" },
      { shortcut: "t", name: "Test" },
    ]);
  });

  it("skips task when all chars conflict", () => {
    const tasks: Record<string, TaskConfig> = {
      a: { name: "First", commands: "first", shortcut: "a" },
      a2: { name: "Second", commands: "second" },
    };
    const result = getTaskShortcuts(tasks);
    // "a" taken by first, "2" is the only remaining unique char for "a2"
    expect(result).toEqual([
      { shortcut: "a", name: "First" },
      { shortcut: "2", name: "Second" },
    ]);
  });

  it("skips task when explicit shortcut conflicts", () => {
    const tasks: Record<string, TaskConfig> = {
      build: { name: "Build", commands: "build", shortcut: "b" },
      bundle: { name: "Bundle", commands: "bundle", shortcut: "b" },
    };
    const result = getTaskShortcuts(tasks);
    expect(result).toEqual([{ shortcut: "b", name: "Build" }]);
  });

  it("returns empty array for empty tasks", () => {
    expect(getTaskShortcuts({})).toEqual([]);
  });
});
