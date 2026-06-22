import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `displayPopup` is the tmux boundary. Replace it with a runner that executes the
// Popup's shell command directly (no tmux), with empty stdin so the `read`
// Wait-for-enter fallback returns immediately. This exercises the temp-file
// Passback (write lines in → view them) hermetically. `tmuxSupportsPopup` is
// Stubbed for the availability test.
let lastOutput = "";

vi.mock("../../../src/lib/tmux.js", () => ({
  displayPopup: vi.fn((opts: { command: string; title?: string }): void => {
    lastOutput = execFileSync("sh", ["-c", opts.command], { input: "", encoding: "utf8" });
  }),
  tmuxSupportsPopup: vi.fn(),
}));

const { outputPopupAvailable, showOutputPopup } =
  await import("../../../src/lib/task/output-popup.js");
const { displayPopup, tmuxSupportsPopup } = await import("../../../src/lib/tmux.js");

beforeEach(() => {
  vi.clearAllMocks();
  lastOutput = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outputPopupAvailable", () => {
  it("mirrors tmux popup support", async () => {
    vi.mocked(tmuxSupportsPopup).mockResolvedValue(true);
    expect(await outputPopupAvailable()).toBe(true);
    vi.mocked(tmuxSupportsPopup).mockResolvedValue(false);
    expect(await outputPopupAvailable()).toBe(false);
  });
});

describe("showOutputPopup", () => {
  it("writes the lines to a temp file the popup viewer reads back", async () => {
    await showOutputPopup("Failed: build", ["compiling", "boom: failed", "exit 1"]);
    expect(vi.mocked(displayPopup)).toHaveBeenCalledTimes(1);
    expect(lastOutput).toContain("compiling");
    expect(lastOutput).toContain("boom: failed");
    expect(lastOutput).toContain("exit 1");
  });

  it("passes the title and a sized popup to displayPopup", async () => {
    await showOutputPopup("Failed: build", ["x"]);
    const opts = vi.mocked(displayPopup).mock.calls[0]?.[0];
    expect(opts?.title).toBe("Failed: build");
    expect(opts?.width).toBeDefined();
    expect(opts?.height).toBeDefined();
    expect(opts?.command).toContain("sh -c");
  });

  it("handles empty output without error", async () => {
    await expect(showOutputPopup("Failed: build", [])).resolves.toBeUndefined();
    expect(vi.mocked(displayPopup)).toHaveBeenCalledTimes(1);
  });
});
