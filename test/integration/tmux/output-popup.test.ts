import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import { showOutputPopup } from "#src/lib/task/output-popup.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { hasScriptPty, hasTmux, isCI } from "../helpers/skip.js";
import type { AttachedClient, TestSession } from "../helpers/tmux.js";
import { attachClient, createTestSession, testTmuxSocket } from "../helpers/tmux.js";

// The `display-popup` failed-output escalation (Q3) needs a genuinely
// Interactive attached client. CI runners only fake one via `script` — the pty
// Satisfies hasScriptPty() but tmux still can't host the popup there (exit 1),
// So skip on CI, mirroring the binary-smoke gate. Hermetic coverage of this
// Path lives in test/lib/task/output-popup.test.ts (runs everywhere).
const handle = tmuxFor(testTmuxSocket());
const popupSupported = hasTmux() ? await handle.tmuxSupportsPopup() : false;
const canRunPopup = popupSupported && hasScriptPty() && !isCI;

/**
 * Shadow `less` on the session PATH with a stub that copies the file it is asked
 * to view into `marker`, then exits 0. This makes the otherwise-interactive
 * popup viewer self-close (so `displayPopup -EE` resolves) while revealing the
 * exact content the popup rendered — i.e. proves the popup carried the output.
 */
function installLessShim(dir: string, marker: string): void {
  const shim = path.join(dir, "less");
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'for a in "$@"; do f="$a"; done',
      `cat "$f" > ${JSON.stringify(marker)}`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(shim, 0o755);
}

describe.skipIf(!canRunPopup)("output-popup escalation tmux integration", () => {
  let tmux: TestSession;
  let client: AttachedClient;
  let binDir: string;
  let marker: string;

  beforeEach(async () => {
    tmux = await createTestSession();
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-popup-bin-"));
    marker = path.join(binDir, "rendered.txt");
    installLessShim(binDir, marker);
    client = await attachClient(tmux.name);
  });

  afterEach(async () => {
    client.cleanup();
    await tmux.cleanup();
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("opens a display-popup containing the failed output", async () => {
    const failed = ["compiling project", "src/index.ts: TypeError", "task failed: exit 1"];

    const operations = new TmuxTerminalOperations(
      handle,
      tmux.name,
      tmux.initialPaneId,
      new TmuxTerminalLeaseRegistry(),
    );
    try {
      await operations.run(
        {
          owner: { kind: "ui", socketId: "output-popup", sessionId: tmux.name },
          env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
          cwd: binDir,
          signal: new AbortController().signal,
        },
        async (operation) => showOutputPopup("Failed: build", failed, operation),
      );
    } finally {
      await operations.dispose();
    }

    expect(fs.existsSync(marker)).toBe(true);
    const rendered = fs.readFileSync(marker, "utf8");
    for (const line of failed) {
      expect(rendered).toContain(line);
    }
  });
});
