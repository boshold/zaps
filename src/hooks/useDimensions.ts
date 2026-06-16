import { useStdout } from "ink";
import { useEffect, useState } from "react";

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
  // Frozen at the size read on first render (F11).
  useEffect(() => {
    if (!stdout) {
      return;
    }
    function onResize() {
      setSize(readSize(stdout));
    }
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const { cols, rows } = size;
  return { cols, rows, compact: rows < 12, narrow: cols < 50, medium: cols < 120 };
}
