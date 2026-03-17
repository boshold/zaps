import { useStdout } from "ink";

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
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  return { cols, rows, compact: rows < 12, narrow: cols < 50, medium: cols < 120 };
}
