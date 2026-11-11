import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalOperationContext } from "../../../src/lib/backend/tmux/operations.js";
import { shellEscape } from "../../../src/lib/service/env.js";
import {
  buildFzfScript,
  parseSelection,
  popupPickerAvailable,
  runPopupPicker,
} from "../../../src/lib/task/popup-picker.js";

const TASKS = [
  { key: "migrate", name: "Migrate DB" },
  { key: "seed", name: "Seed database" },
  { key: "build", name: "Build app" },
];

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zaps-popup-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("buildFzfScript", () => {
  it("displays only the name column and routes the pick through the temp files", () => {
    const script = buildFzfScript("/tmp/in", "/tmp/out");
    expect(script).toContain("fzf --with-nth=2..");
    expect(script).toContain("< '/tmp/in'");
    expect(script).toContain("> '/tmp/out'");
    // Always exits 0 so the popup closes even on cancel.
    expect(script.trim().endsWith("exit 0")).toBe(true);
  });
});

describe("parseSelection", () => {
  it("recovers the key from a `key<TAB>name` line", () => {
    expect(parseSelection("migrate\tMigrate DB\n")).toBe("migrate");
  });

  it("returns null for an empty selection (cancel)", () => {
    expect(parseSelection("")).toBeNull();
    expect(parseSelection("\n  \n")).toBeNull();
  });

  it("uses the first non-empty line", () => {
    expect(parseSelection("\nseed\tSeed database\nbuild\tBuild app\n")).toBe("seed");
  });
});

describe("popupPickerAvailable", () => {
  it("is false when tmux lacks popup support (even if fzf is present)", async () => {
    const tmux = { tmuxSupportsPopup: async () => false };
    expect(await popupPickerAvailable(tmux, { PATH: process.env.PATH ?? "" })).toBe(false);
  });
});

describe("runPopupPicker", () => {
  const popup = vi.fn<TerminalOperationContext["popup"]>(async ({ command }) => {
    execFileSync("sh", ["-c", command], { stdio: "ignore" });
  });

  function makeOperation(): TerminalOperationContext {
    popup.mockClear();
    return {
      directory,
      cwd: directory,
      env: {},
      signal: new AbortController().signal,
      popup,
      capture: async () => "",
    };
  }

  it("writes the task list, runs the picker, and returns the selected key", async () => {
    const pickSecond = (inFile: string, outFile: string) =>
      `sed -n 2p ${shellEscape(inFile)} > ${shellEscape(outFile)}`;
    const key = await runPopupPicker(TASKS, {
      operation: makeOperation(),
      buildScript: pickSecond,
    });
    expect(key).toBe("seed");
    expect(popup).toHaveBeenCalledOnce();
  });

  it("returns null when the picker writes no selection (cancel)", async () => {
    const pickNothing = (_inFile: string, outFile: string) => `: > ${shellEscape(outFile)}`;
    const key = await runPopupPicker(TASKS, {
      operation: makeOperation(),
      buildScript: pickNothing,
    });
    expect(key).toBeNull();
  });
});
