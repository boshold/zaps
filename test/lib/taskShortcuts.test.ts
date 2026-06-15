import { describe, expect, it } from "vitest";

import type { TaskConfig } from "../../src/config/types.js";
import { RESERVED_TASK_SHORTCUT_KEYS, getTaskShortcuts } from "../../src/lib/taskShortcuts.js";

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

  it("reserves exactly q, j, k", () => {
    expect([...RESERVED_TASK_SHORTCUT_KEYS].toSorted()).toEqual(["j", "k", "q"]);
  });

  it("never auto-assigns a reserved key (q/j/k)", () => {
    const tasks: Record<string, TaskConfig> = {
      quality: { name: "Quality", commands: "lint" },
      jobs: { name: "Jobs", commands: "jobs" },
      kill: { name: "Kill", commands: "kill" },
    };
    const result = getTaskShortcuts(tasks);
    // "quality" skips reserved 'q' → 'u'; "jobs" skips 'j' → 'o'; "kill" skips 'k' → 'i'.
    expect(result).toEqual([
      { shortcut: "u", name: "Quality" },
      { shortcut: "o", name: "Jobs" },
      { shortcut: "i", name: "Kill" },
    ]);
  });

  it("drops an explicit reserved shortcut with no fallback", () => {
    const tasks: Record<string, TaskConfig> = {
      kill: { name: "Kill", commands: "kill", shortcut: "q" },
      jump: { name: "Jump", commands: "jump", shortcut: "j" },
      kustom: { name: "Kustom", commands: "kustom", shortcut: "k" },
      build: { name: "Build", commands: "build", shortcut: "b" },
    };
    const result = getTaskShortcuts(tasks);
    // The three reserved-key requests are dropped entirely; only "build" keeps its shortcut.
    expect(result).toEqual([{ shortcut: "b", name: "Build" }]);
  });
});
