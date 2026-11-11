import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalOperationContext } from "../../../src/lib/backend/tmux/operations.js";
import { showOutputPopup } from "../../../src/lib/task/output-popup.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zaps-popup-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("showOutputPopup", () => {
  let lastOutput = "";
  const popup = vi.fn<TerminalOperationContext["popup"]>(async ({ command }) => {
    lastOutput = execFileSync("sh", ["-c", command], { input: "", encoding: "utf8" });
  });

  function makeOperation(): TerminalOperationContext {
    lastOutput = "";
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

  it("writes the lines to a temp file the popup viewer reads back", async () => {
    await showOutputPopup(
      "Failed: build",
      ["compiling", "boom: failed", "exit 1"],
      makeOperation(),
    );
    expect(popup).toHaveBeenCalledTimes(1);
    expect(lastOutput).toContain("compiling");
    expect(lastOutput).toContain("boom: failed");
    expect(lastOutput).toContain("exit 1");
  });

  it("passes the title and a sized popup to displayPopup", async () => {
    await showOutputPopup("Failed: build", ["x"], makeOperation());
    const opts = popup.mock.calls[0]?.[0];
    expect(opts?.title).toBe("Failed: build");
    expect(opts?.width).toBeDefined();
    expect(opts?.height).toBeDefined();
    expect(opts?.command).toContain("sh -c");
  });

  it("handles empty output without error", async () => {
    await expect(showOutputPopup("Failed: build", [], makeOperation())).resolves.toBeUndefined();
    expect(popup).toHaveBeenCalledTimes(1);
  });
});
