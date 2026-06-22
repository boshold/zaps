import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { shellEscape } from "#src/lib/service/env.js";
import { displayPopup, tmuxSupportsPopup } from "#src/lib/tmux.js";

/** True when tmux supports `display-popup` (>= 3.2) — the escalation target (Q3). */
export async function outputPopupAvailable(): Promise<boolean> {
  return tmuxSupportsPopup();
}

/**
 * Show captured task output in a larger `tmux display-popup` (the failed-output
 * overlay's escalation, Q3). Lines are written to a temp file (the
 * `editPaneCapture`/popup-picker pattern) and viewed with `less -R`, falling
 * back to `cat` + a wait-for-enter so the popup stays open on hosts without
 * `less`. Everything runs under `sh -c` (fish-safe). The temp dir is always
 * cleaned up. Callers should gate on {@link outputPopupAvailable} first.
 */
export async function showOutputPopup(title: string, lines: string[]): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaps-task-output-"));
  const file = path.join(dir, "output");
  try {
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    const esc = shellEscape(file);
    // `less` for scrollback; if absent, print + pause so -EE doesn't close instantly.
    const viewer = `less -R ${esc} 2>/dev/null || { cat ${esc}; printf '\\n[press enter to close]'; read _; }`;
    await displayPopup({
      command: `sh -c ${shellEscape(viewer)}`,
      title,
      width: "80%",
      height: "80%",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
