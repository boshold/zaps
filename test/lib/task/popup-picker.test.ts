import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shellEscape } from "../../../src/lib/service/env.js";

// `displayPopup` is the tmux boundary. Replace it with a runner that executes the
// Popup's shell command directly (no tmux), so the temp-file passback — write
// `key\tname` in, run the picker script, read the selection out — is exercised
// Hermetically. `tmuxSupportsPopup` is stubbed for the availability test.
vi.mock("../../../src/lib/tmux.js", () => ({
  displayPopup: vi.fn((opts: { command: string }): void => {
    execFileSync("sh", ["-c", opts.command], { stdio: "ignore" });
  }),
  tmuxSupportsPopup: vi.fn(),
}));

const { buildFzfScript, parseSelection, popupPickerAvailable, runPopupPicker } =
  await import("../../../src/lib/task/popup-picker.js");
const { displayPopup, tmuxSupportsPopup } = await import("../../../src/lib/tmux.js");

const TASKS = [
  { key: "migrate", name: "Migrate DB" },
  { key: "seed", name: "Seed database" },
  { key: "build", name: "Build app" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    vi.mocked(tmuxSupportsPopup).mockResolvedValue(false);
    expect(await popupPickerAvailable()).toBe(false);
  });
});

describe("runPopupPicker", () => {
  it("writes the task list, runs the picker, and returns the selected key", async () => {
    // Stub picker: select the 2nd task (mirrors what fzf would emit).
    const pickSecond = (inFile: string, outFile: string) =>
      `sed -n 2p ${shellEscape(inFile)} > ${shellEscape(outFile)}`;
    const key = await runPopupPicker(TASKS, { buildScript: pickSecond });
    expect(key).toBe("seed");
    expect(vi.mocked(displayPopup)).toHaveBeenCalledTimes(1);
  });

  it("returns null when the picker writes no selection (cancel)", async () => {
    const pickNothing = (_inFile: string, outFile: string) => `: > ${shellEscape(outFile)}`;
    const key = await runPopupPicker(TASKS, { buildScript: pickNothing });
    expect(key).toBeNull();
  });
});
