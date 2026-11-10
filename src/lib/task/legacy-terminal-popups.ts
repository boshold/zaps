// P05-T04 removes this bridge when UI callers use terminal.action.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { shellEscape } from "#src/lib/service/env.js";
import { defaultTmux } from "#src/lib/tmux-default.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

/** The tmux commands the picker popup issues. */
type PopupTmux = Pick<TmuxHandle, "displayPopup" | "tmuxSupportsPopup">;

/** Resolve true if `cmd --version` runs (a cheap presence probe). */
async function binaryAvailable(
  cmd: string,
  env?: Readonly<Record<string, string>>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, ["--version"], { stdio: "ignore", env });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export interface PopupTask {
  key: string;
  name: string;
}

/** Builds the in-popup picker command (injectable so tests can stub `fzf`). */
export type PickerScriptBuilder = (inFile: string, outFile: string) => string;

export interface PopupPickerOptions {
  /** Override the in-popup picker command — tests inject a non-interactive stub. */
  buildScript?: PickerScriptBuilder;
  /** Tmux surface for the popup; defaults to the env-based handle. */
  tmux?: PopupTmux;
}

/**
 * Build the `fzf` script run inside the popup. The task list is fed in as
 * `key\tname` lines; `--with-nth=2..` displays only the name while the selected
 * line fzf emits is still the original `key\tname`, so the key is recovered from
 * field 1. A trailing `exit 0` makes the popup close even when fzf is cancelled
 * (non-zero exit), in which case the output file is empty → no selection.
 */
export function buildFzfScript(inFile: string, outFile: string): string {
  return `fzf --with-nth=2.. < ${shellEscape(inFile)} > ${shellEscape(outFile)}; exit 0`;
}

/** Recover the task key from a selected `key\tname` line (empty → null). */
export function parseSelection(raw: string): string | null {
  const line = raw.split("\n").find((l) => l.trim().length > 0);
  if (!line) {
    return null;
  }
  const key = line.split("\t")[0]?.trim();
  return key || null;
}

/** True when both tmux (>= 3.2, for `display-popup`) and `fzf` are available. */
export async function legacyPopupPickerAvailable(
  tmux: PopupTmux = defaultTmux,
  env?: Readonly<Record<string, string>>,
): Promise<boolean> {
  const [tmuxOk, fzfOk] = await Promise.all([
    tmux.tmuxSupportsPopup(),
    binaryAvailable("fzf", env),
  ]);
  return tmuxOk && fzfOk;
}

/**
 * Open the task list as `fzf` inside a tmux `display-popup`, returning the
 * selected task key (or null when cancelled). The selection is passed back via a
 * temp file (the `editPaneCapture` pattern): node writes `key\tname` lines in,
 * the popup writes the chosen line out, node reads + parses it after it closes.
 */
export async function legacyRunPopupPicker(
  tasks: PopupTask[],
  opts?: PopupPickerOptions,
): Promise<string | null> {
  const build = opts?.buildScript ?? buildFzfScript;
  const tmux = opts?.tmux ?? defaultTmux;
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaps-task-pick-"));
  const inFile = path.join(dir, "tasks");
  const outFile = path.join(dir, "selection");
  try {
    const lines = tasks.map((t) => `${t.key}\t${t.name}`).join("\n");
    await writeFile(inFile, `${lines}\n`, "utf8");
    await tmux.displayPopup({
      command: `sh -c ${shellEscape(build(inFile, outFile))}`,
      title: "Run a task",
      width: "60%",
      height: "50%",
    });
    const raw = await readFile(outFile, "utf8").catch(() => "");
    return parseSelection(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True when tmux supports `display-popup` (>= 3.2) — the escalation target (Q3). */
export async function legacyOutputPopupAvailable(tmux: PopupTmux = defaultTmux): Promise<boolean> {
  return tmux.tmuxSupportsPopup();
}

/**
 * Show captured task output in a larger `tmux display-popup` (the failed-output
 * overlay's escalation, Q3). Lines are written to a temp file (the
 * `editPaneCapture`/popup-picker pattern) and viewed with `less -R`, falling
 * back to `cat` + a wait-for-enter so the popup stays open on hosts without
 * `less`. Everything runs under `sh -c` (fish-safe). The temp dir is always
 * cleaned up. Callers should gate on {@link outputPopupAvailable} first.
 */
export async function legacyShowOutputPopup(
  title: string,
  lines: string[],
  tmux: PopupTmux = defaultTmux,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaps-task-output-"));
  const file = path.join(dir, "output");
  try {
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    const esc = shellEscape(file);
    // `less` for scrollback; if absent, print + pause so -EE doesn't close instantly.
    const viewer = `less -R ${esc} 2>/dev/null || { cat ${esc}; printf '\\n[press enter to close]'; read _; }`;
    await tmux.displayPopup({
      command: `sh -c ${shellEscape(viewer)}`,
      title,
      width: "80%",
      height: "80%",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
