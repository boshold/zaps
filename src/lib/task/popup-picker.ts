import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerminalOperationContext } from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";

import {
  buildFzfScript,
  legacyPopupPickerAvailable,
  legacyRunPopupPicker,
  parseSelection,
} from "./legacy-terminal-popups.js";
import type { PopupPickerOptions, PopupTask } from "./legacy-terminal-popups.js";

interface OwnedPickerOptions {
  readonly operation: TerminalOperationContext;
  readonly buildScript?: PopupPickerOptions["buildScript"];
}

// P05-T04 removes the legacy signature with the UI caller migration.
export async function runPopupPicker(
  tasks: PopupTask[],
  opts?: PopupPickerOptions | OwnedPickerOptions,
): Promise<string | null> {
  if (!opts || !("operation" in opts)) {
    return legacyRunPopupPicker(tasks, opts);
  }
  const context = opts.operation;
  context.signal.throwIfAborted();
  const input = path.join(context.directory, "tasks");
  const output = path.join(context.directory, "selection");
  await writeFile(
    input,
    `${tasks.map((task) => `${task.key}\t${task.name}`).join("\n")}\n`,
    "utf8",
  );
  await context.popup({
    command: `sh -c ${shellEscape((opts.buildScript ?? buildFzfScript)(input, output))}`,
    title: "Run a task",
    width: "60%",
    height: "50%",
  });
  return parseSelection(await readFile(output, "utf8").catch(() => ""));
}

export { buildFzfScript, parseSelection, legacyPopupPickerAvailable as popupPickerAvailable };
export type {
  PopupTask,
  PopupPickerOptions,
  PickerScriptBuilder,
} from "./legacy-terminal-popups.js";
