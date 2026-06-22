/**
 * Ink force-clears the terminal only when the width *decreases* (see ink's
 * `resized`: it resets `lastOutput` and clears solely on `currentWidth <
 * lastTerminalWidth`). Every other resize — width grow, width-stable height
 * change, height grow — keeps the previous frame's accounting and repaints via
 * a line-diff, which leaves overlapping residue from the old layout (e.g. the
 * detail divider stranded at the old column while new full-width rules paint
 * over it). zaps splits panes *after* the TUI mounts, so the @tui pane keeps
 * growing into its final size and trips exactly this gap on first start.
 *
 * We fill the gap from the host side: on the resizes Ink mishandles, hard-clear
 * the screen + scrollback so the next frame (driven by the live layout reflow
 * in useDimensions) paints once, clean, at the new size.
 */

/** Erase screen (2J), scrollback (3J), and home the cursor (H). */
const HARD_CLEAR = "\x1b[2J\x1b[3J\x1b[H";

// Briefly poll for size changes after install, mirroring useDimensions' warm-up:
// Zaps' startup pane splits can settle without delivering a Node `resize` event
// To this listener, so the poll catches those changes and still mops up residue.
const WARMUP_MS = 100;
const WARMUP_TICKS = 15;

interface Size {
  cols: number;
  rows: number;
}

function readSize(stdout: NodeJS.WriteStream): Size {
  return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
}

/**
 * Whether the host must hard-clear for this resize. Ink already clears cleanly
 * on a width decrease, so we skip that case (avoids a redundant flash); we clear
 * for width grows and height-only changes, which Ink leaves as residue.
 */
export function needsHardClear(prev: Size, next: Size): boolean {
  if (next.cols < prev.cols) {
    return false; // Ink handles width shrink itself.
  }
  return next.cols !== prev.cols || next.rows !== prev.rows;
}

/**
 * Subscribe to terminal resizes and hard-clear on the cases Ink mishandles.
 * Returns an unsubscribe function. No-op (returns a no-op cleanup) for non-TTY
 * streams, where there is no frame residue to mop up.
 */
export function installResizeReset(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) {
    return () => {
      /* Empty */
    };
  }
  let prev = readSize(stdout);
  function onResize(): void {
    const next = readSize(stdout);
    if (needsHardClear(prev, next)) {
      stdout.write(HARD_CLEAR);
    }
    prev = next;
  }
  stdout.on("resize", onResize);
  let ticks = 0;
  const warmup = setInterval(() => {
    onResize();
    ticks += 1;
    if (ticks >= WARMUP_TICKS) {
      clearInterval(warmup);
    }
  }, WARMUP_MS);
  return () => {
    stdout.off("resize", onResize);
    clearInterval(warmup);
  };
}
