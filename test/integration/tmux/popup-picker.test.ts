import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";
import {
  buildFzfScript,
  parseSelection,
  popupPickerAvailable,
  runPopupPicker,
} from "#src/lib/task/popup-picker.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { hasScriptPty, hasTmux, isCI } from "../helpers/skip.js";
import { attachClient, createTestSession, testTmuxSocket } from "../helpers/tmux.js";

const handle = tmuxFor(testTmuxSocket());
const env = { PATH: process.env.PATH ?? "" };

function hasFzf(): boolean {
  try {
    execFileSync("fzf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const available = hasTmux() && hasFzf();

describe.skipIf(!hasTmux())("popup-picker tmux integration", () => {
  it("detects the real tmux version and popup support", async () => {
    const version = await handle.tmuxVersion();
    expect(version).not.toBeNull();
    expect(version?.major).toBeGreaterThanOrEqual(1);
    // The harness's tmux is modern (>= 3.2), so popups are supported.
    expect(await handle.tmuxSupportsPopup()).toBe(true);
  });

  it.skipIf(!available)(
    "reports the popup picker as available when tmux + fzf are present",
    async () => {
      expect(await popupPickerAvailable(handle, env)).toBe(true);
    },
  );

  it.skipIf(!available)("real fzf emits the key-bearing line the parser recovers", () => {
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

  it.skipIf(!available || !hasScriptPty() || isCI)(
    "returns the selection from an owned popup",
    async () => {
      const session = await createTestSession();
      const operations = new TmuxTerminalOperations(
        handle,
        session.name,
        session.initialPaneId,
        new TmuxTerminalLeaseRegistry(),
      );
      const client = await attachClient(session.name);
      try {
        const key = await operations.run(
          {
            owner: { kind: "ui", socketId: "popup-picker", sessionId: session.name },
            env,
            cwd: process.cwd(),
            signal: new AbortController().signal,
          },
          async (operation) =>
            runPopupPicker([{ key: "seed", name: "Seed database" }], {
              operation,
              buildScript: (input, output) =>
                `fzf --filter=seed --with-nth=2.. < ${shellEscape(input)} > ${shellEscape(output)}`,
            }),
        );
        expect(key).toBe("seed");
      } finally {
        try {
          await operations.dispose();
        } finally {
          try {
            client.cleanup();
          } finally {
            await session.cleanup();
          }
        }
      }
    },
  );
});
