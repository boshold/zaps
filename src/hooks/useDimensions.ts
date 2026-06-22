import { useStdout } from "ink";
import { useEffect, useState } from "react";

// After mount, poll the terminal size briefly. zaps splits its service/log panes
// Around `zaps up`, so the settling SIGWINCH can fire before this hook's effect
// Attaches its `resize` listener (effects flush a microtask after Ink's
// `render()`). The poll lets the layout self-heal to the real pane size even
// When that first event was missed — otherwise the frame stays frozen at a
// Transient startup width until a manual resize (the first-render garble).
const WARMUP_MS = 100;
const WARMUP_TICKS = 15;

function readSize(stdout: NodeJS.WriteStream | undefined): { cols: number; rows: number } {
  return { cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 };
}

export interface Dimensions {
  cols: number;
  rows: number;
  /** Rows < 12 — hide non-essential chrome */
  compact: boolean;
  /** Cols < 50 — simplified column layout */
  narrow: boolean;
  /** Cols < 120 — hide output panel, side-by-side task list + history */
  medium: boolean;
}

export function useDimensions(): Dimensions {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readSize(stdout));

  // Subscribe to terminal resize so the layout reflows live instead of being
  // Frozen at the size read on first render (F11). A mount re-read + brief
  // Warm-up poll cover SIGWINCHes that land before this listener attaches (see
  // WARMUP_* above) so the layout converges to the real pane size on its own.
  useEffect(() => {
    if (!stdout) {
      return;
    }
    function sync() {
      const next = readSize(stdout);
      setSize((prev) => (prev.cols === next.cols && prev.rows === next.rows ? prev : next));
    }
    // Catch a size that changed between the useState seed and this effect.
    sync();
    stdout.on("resize", sync);
    let ticks = 0;
    const warmup = setInterval(() => {
      sync();
      ticks += 1;
      if (ticks >= WARMUP_TICKS) {
        clearInterval(warmup);
      }
    }, WARMUP_MS);
    return () => {
      stdout.off("resize", sync);
      clearInterval(warmup);
    };
  }, [stdout]);

  const { cols, rows } = size;
  return { cols, rows, compact: rows < 12, narrow: cols < 50, medium: cols < 120 };
}
