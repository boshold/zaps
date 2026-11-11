import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerminalOperationContext } from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";

export async function showOutputPopup(
  title: string,
  lines: string[],
  operation: TerminalOperationContext,
): Promise<void> {
  operation.signal.throwIfAborted();
  const file = path.join(operation.directory, "output");
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  const escaped = shellEscape(file);
  const viewer = `less -R ${escaped} 2>/dev/null || { cat ${escaped}; printf '\\n[press enter to close]'; read _; }`;
  await operation.popup({
    command: `sh -c ${shellEscape(viewer)}`,
    title,
    width: "80%",
    height: "80%",
  });
}
