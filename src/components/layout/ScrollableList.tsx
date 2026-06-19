import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useIcons } from "#src/components/theme/IconTheme.js";

interface ScrollableListProps<T> {
  items: T[];
  /** Index that must stay visible; clamped to list bounds. */
  selectedIndex: number;
  /** Line budget for the list — typically the measured viewport height. */
  maxHeight: number;
  /** Rows a given item occupies (group header + error sub-row, etc.). Default 1. */
  rowHeight?: (item: T, index: number) => number;
  renderItem: (item: T, index: number, selected: boolean) => ReactNode;
  /** Show themed up/down "N more" markers (each reserves a line when shown). Default true. */
  overflowMarkers?: boolean;
}

/** Stable default so the optional `rowHeight` prop keeps referential equality. */
const defaultRowHeight = () => 1;

/**
 * Pick the contiguous range of items to show. Grows outward from the selected
 * item (so it stays visible), optionally reserving a line for each "N more"
 * marker, until the line budget (`maxHeight`) is spent. Extracted verbatim from
 * the proven `ServiceList.computeWindow` so existing behavior is preserved.
 */
function computeWindow(
  heights: number[],
  selectedIndex: number,
  maxHeight: number,
  reserveMarkers: boolean,
): { start: number; end: number } {
  const n = heights.length;
  let start = selectedIndex;
  let end = selectedIndex + 1;
  let used = heights[selectedIndex] ?? 0;

  let grew = true;
  while (grew) {
    grew = false;
    const budget = reserveMarkers ? maxHeight - (start > 0 ? 1 : 0) - (end < n ? 1 : 0) : maxHeight;
    if (end < n && used + heights[end] <= budget) {
      used += heights[end];
      end += 1;
      grew = true;
      continue;
    }
    if (start > 0 && used + heights[start - 1] <= budget) {
      used += heights[start - 1];
      start -= 1;
      grew = true;
    }
  }

  return { start, end };
}

/**
 * Reusable windowing list: renders only the slice of `items` that fits
 * `maxHeight`, keeps `selectedIndex` in view, and emits themed "N more" overflow
 * markers. Generalized from `ServiceList`'s windowing so the dashboard list, log
 * view, task picker, and failed-output viewer can all share one implementation.
 */
function ScrollableList<T>({
  items,
  selectedIndex,
  maxHeight,
  rowHeight = defaultRowHeight,
  renderItem,
  overflowMarkers = true,
}: ScrollableListProps<T>) {
  const { icon } = useIcons();
  const total = items.length;
  if (total === 0) {
    return <Box flexDirection="column" />;
  }

  const selected = Math.max(0, Math.min(selectedIndex, total - 1));
  const heights = items.map((item, i) => rowHeight(item, i));
  const totalLines = heights.reduce((sum, h) => sum + h, 0);

  // No constraint (unbounded or everything fits): render the full list, no markers.
  if (maxHeight <= 0 || totalLines <= maxHeight) {
    return (
      <Box flexDirection="column">
        {items.map((item, i): ReactNode => renderItem(item, i, i === selected))}
      </Box>
    );
  }

  const { start, end } = computeWindow(heights, selected, maxHeight, overflowMarkers);
  const above = start;
  const below = total - end;

  return (
    <Box flexDirection="column">
      {overflowMarkers && above > 0 && (
        <Text dimColor>
          {"  "}
          {icon("overflowUp")} {above} more
        </Text>
      )}
      {items
        .slice(start, end)
        .map((item, i): ReactNode => renderItem(item, i + start, i + start === selected))}
      {overflowMarkers && below > 0 && (
        <Text dimColor>
          {"  "}
          {icon("overflowDown")} {below} more
        </Text>
      )}
    </Box>
  );
}

export { ScrollableList };
export type { ScrollableListProps };
