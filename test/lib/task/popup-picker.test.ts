import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalOperationContext } from "../../../src/lib/backend/tmux/operations.js";
import { shellEscape } from "../../../src/lib/service/env.js";
import {
  buildFzfScript,
  formatPickerLine,
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
    expect(script).toContain(String.raw`--delimiter='\t'`);
    expect(script).toContain("--with-nth=2..");
    expect(script).toContain("--nth=1");
    expect(script).toContain("--ansi");
    expect(script).toContain("< '/tmp/in'");
    expect(script).toContain("> '/tmp/out'");
    // Always exits 0 so the popup closes even on cancel.
    expect(script.trim().endsWith("exit 0")).toBe(true);
  });
});

const hasFzf = (() => {
  try {
    execFileSync("fzf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFzf)("fzf script with real fzf", () => {
  async function filter(query: string) {
    const input = path.join(directory, "in");
    const output = path.join(directory, "out");
    await writeFile(
      input,
      `${[
        { key: "verify", name: "Verify mail", requiredServices: ["mailhog", "api"] },
        { key: "lint", name: "Lint code" },
      ]
        .map(formatPickerLine)
        .join("\n")}\n`,
    );
    const script = buildFzfScript(input, output).replace("fzf ", `fzf --filter=${query} `);
    execFileSync("sh", ["-c", script]);
    return readFile(output, "utf8");
  }

  it("matches on the name only and keeps the key parseable", async () => {
    expect(parseSelection(await filter("mail"))).toBe("verify");
    expect(await filter("api")).toBe("");
    expect(parseSelection(await filter("lint"))).toBe("lint");
  });
});

describe("formatPickerLine", () => {
  it("writes `key<TAB>name` for independent tasks", () => {
    expect(formatPickerLine({ key: "lint", name: "Lint code" })).toBe("lint\tLint code");
    expect(formatPickerLine({ key: "lint", name: "Lint code", requiredServices: [] })).toBe(
      "lint\tLint code",
    );
  });

  it("appends the dimmed required services as a third column", () => {
    expect(
      formatPickerLine({
        key: "verify",
        name: "Verify mail",
        requiredServices: ["mailhog", "api"],
      }),
    ).toBe("verify\tVerify mail\t\u001B[2mneeds mailhog, api\u001B[0m");
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

  it("recovers the key from a line with a services column", () => {
    expect(parseSelection("verify\tVerify mail\tneeds mailhog\n")).toBe("verify");
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

  it("writes the services column and still returns the selected key", async () => {
    const pickFirst = (inFile: string, outFile: string) =>
      `sed -n 1p ${shellEscape(inFile)} > ${shellEscape(outFile)}`;
    const key = await runPopupPicker(
      [{ key: "verify", name: "Verify mail", requiredServices: ["mailhog"] }],
      { operation: makeOperation(), buildScript: pickFirst },
    );
    expect(key).toBe("verify");
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
