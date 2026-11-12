import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TerminalOperationContext } from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

/** Resolve true if `cmd --version` runs (a cheap presence probe). */
async function binaryAvailable(
  cmd: string,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, ["--version"], { stdio: "ignore", env });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

interface PopupTask {
  key: string;
  name: string;
  requiredServices?: string[];
}

/** Builds the in-popup picker command (injectable so tests can stub `fzf`). */
type PickerScriptBuilder = (inFile: string, outFile: string) => string;

const DIM = "\u001B[2m";
const RESET = "\u001B[0m";

/** One `key\tname[\tneeds …]` picker line; the services column is dimmed. */
function formatPickerLine(task: PopupTask): string {
  const services = task.requiredServices ?? [];
  const needs = services.length > 0 ? `\t${DIM}needs ${services.join(", ")}${RESET}` : "";
  return `${task.key}\t${task.name}${needs}`;
}

/**
 * Build the `fzf` script run inside the popup. Lines are tab-delimited
 * `key\tname[\tneeds …]`; `--with-nth=2..` hides the key, `--nth=1` (relative to
 * the displayed fields) restricts matching to the name. The emitted line is the
 * original, so the key is recovered from field 1. A trailing `exit 0` closes the
 * popup even when fzf is cancelled, leaving the output empty → no selection.
 */
function buildFzfScript(inFile: string, outFile: string): string {
  return `fzf --ansi --delimiter='\\t' --with-nth=2.. --nth=1 < ${shellEscape(inFile)} > ${shellEscape(outFile)}; exit 0`;
}

/** Recover the task key from a selected `key\tname` line (empty → null). */
function parseSelection(raw: string): string | null {
  const line = raw.split("\n").find((l) => l.trim().length > 0);
  if (!line) {
    return null;
  }
  const key = line.split("\t")[0]?.trim();
  return key || null;
}

/** True when both tmux (>= 3.2, for `display-popup`) and `fzf` are available. */
async function popupPickerAvailable(
  tmux: Pick<TmuxHandle, "tmuxSupportsPopup">,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  const [tmuxOk, fzfOk] = await Promise.all([
    tmux.tmuxSupportsPopup(),
    binaryAvailable("fzf", env),
  ]);
  return tmuxOk && fzfOk;
}

interface PopupPickerOptions {
  readonly operation: TerminalOperationContext;
  readonly buildScript?: PickerScriptBuilder;
}

async function runPopupPicker(
  tasks: PopupTask[],
  { operation, buildScript = buildFzfScript }: PopupPickerOptions,
): Promise<string | null> {
  operation.signal.throwIfAborted();
  const input = path.join(operation.directory, "tasks");
  const output = path.join(operation.directory, "selection");
  await writeFile(input, `${tasks.map(formatPickerLine).join("\n")}\n`, "utf8");
  await operation.popup({
    command: `sh -c ${shellEscape(buildScript(input, output))}`,
    title: "Run a task",
    width: "60%",
    height: "50%",
  });
  return parseSelection(await readFile(output, "utf8").catch(() => ""));
}

export { buildFzfScript, formatPickerLine, parseSelection, popupPickerAvailable, runPopupPicker };
export type { PopupTask };
