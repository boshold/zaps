import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildFzfScript,
  parseSelection,
  popupPickerAvailable,
  runPopupPicker,
} from "#src/lib/task/popup-picker.js";
import { tmuxSupportsPopup, tmuxVersion } from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";

function hasFzf(): boolean {
  try {
    execFileSync("fzf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasTmux())("popup-picker tmux integration", () => {
  it("detects the real tmux version and popup support", async () => {
    const version = await tmuxVersion();
    expect(version).not.toBeNull();
    expect(version?.major).toBeGreaterThanOrEqual(1);
    // The harness's tmux is modern (>= 3.2), so popups are supported.
    expect(await tmuxSupportsPopup()).toBe(true);
  });

  it.skipIf(!hasFzf())(
    "reports the popup picker as available when tmux + fzf are present",
    async () => {
      expect(await popupPickerAvailable()).toBe(true);
    },
  );

  it.skipIf(!hasFzf())("real fzf emits the key-bearing line the parser recovers", () => {
    // `--filter` is fzf's non-interactive mode: it prints matching original lines
    // (the same lines the popup would emit on selection). This proves the
    // `key\tname` / `--with-nth=2..` contract holds against the real binary.
    const input = ["migrate\tMigrate DB", "seed\tSeed database", "build\tBuild app"].join("\n");
    const out = execFileSync("fzf", ["--filter=seed", "--with-nth=2.."], {
      input,
      encoding: "utf8",
    });
    expect(parseSelection(out)).toBe("seed");
  });

  it("builds a popup script that wires both temp files", () => {
    const script = buildFzfScript("/tmp/in", "/tmp/out");
    expect(script).toContain("< '/tmp/in'");
    expect(script).toContain("> '/tmp/out'");
  });

  // The live `display-popup` launch is intentionally NOT covered here: tmux
  // `display-popup` requires an attached client ("no current client" otherwise),
  // Which the headless test harness (detached sessions, no terminal) cannot
  // Provide. The temp-file passback is covered hermetically in the unit test
  // (test/lib/task/popup-picker.test.ts) by stubbing `displayPopup`. Per
  // P04-T05's note, the live-popup path is left to manual verification.
  it.skip("launches fzf in a live display-popup and runs the selection", async () => {
    await runPopupPicker([{ key: "noop", name: "No-op" }]);
  });
});
