import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerminalOperationContext } from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

import { legacyOutputPopupAvailable, legacyShowOutputPopup } from "./legacy-terminal-popups.js";

type LegacyPopupTmux = Pick<TmuxHandle, "displayPopup" | "tmuxSupportsPopup">;

// P05-T04 removes the legacy signature with the UI caller migration.
export async function showOutputPopup(
  title: string,
  lines: string[],
  target?: LegacyPopupTmux | TerminalOperationContext,
): Promise<void> {
  if (!target || !("directory" in target)) {
    return legacyShowOutputPopup(title, lines, target);
  }
  target.signal.throwIfAborted();
  const file = path.join(target.directory, "output");
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  const escaped = shellEscape(file);
  const viewer = `less -R ${escaped} 2>/dev/null || { cat ${escaped}; printf '\\n[press enter to close]'; read _; }`;
  await target.popup({
    command: `sh -c ${shellEscape(viewer)}`,
    title,
    width: "80%",
    height: "80%",
  });
}

export { legacyOutputPopupAvailable as outputPopupAvailable };
