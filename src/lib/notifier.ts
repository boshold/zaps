import type { UiNotifications } from "#src/config/types.js";

/** BEL terminates an OSC sequence and, on its own, rings the terminal bell. */
const BEL = "\x07";

/**
 * Build an OSC 9 desktop-notification escape (iTerm2 / supporting terminals).
 * The two leading newlines mirror Claude Code's `notifier.ts`; terminals that
 * don't understand OSC 9 drop the whole sequence harmlessly.
 */
function osc9(message: string): string {
  return `\x1b]9;\n\n${message}${BEL}`;
}

/** Default sink — best-effort; a failed stdout write must never crash the TUI. */
function writeStdout(data: string): void {
  try {
    process.stdout.write(data);
  } catch {
    /* Ignore write errors (closed pipe, etc.) */
  }
}

/**
 * Emit a desktop/terminal failure notification per the `ui.notifications`
 * channel, mirroring Claude Code's `notifier.ts` channel model. Fired
 * unconditionally on task failure (no focus gate — focus detection is
 * unreliable across terminals, esp. Wayland); the sticky in-app toast is the
 * primary signal and this is the out-of-band nudge.
 *
 * Only the task name is emitted — never log/output content.
 *
 * @param write injectable sink (defaults to stdout) so tests can capture bytes.
 */
function notifyFailure(
  taskName: string,
  channel: UiNotifications,
  write: (data: string) => void = writeStdout,
): void {
  if (channel === "off") {
    return;
  }
  const wantsOsc9 = channel === "osc9" || channel === "osc9+bell";
  const wantsBell = channel === "bell" || channel === "osc9+bell";
  if (wantsOsc9) {
    write(osc9(`Task failed: ${taskName}`));
  }
  if (wantsBell) {
    write(BEL);
  }
}

export { notifyFailure };
