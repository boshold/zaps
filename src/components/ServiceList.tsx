import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { ServiceRow } from "./ServiceRow.js";
import { showsErrorSubRow } from "./serviceRowError.js";

interface ServiceListProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  maxRows?: number;
  cols: number;
}

/**
 * Track which groups have been seen to render group headers.
 * Returns the group name if this service is the first in its group, else undefined.
 */
function getGroupHeader(
  status: ServiceStatus,
  index: number,
  statuses: ServiceStatus[],
): string | undefined {
  if (!status.group) {
    return undefined;
  }
  // Show header if this is the first service in this group
  if (index === 0 || statuses[index - 1].group !== status.group) {
    return status.group;
  }
  return undefined;
}

/**
 * Number of terminal rows a service's block occupies: an optional group header,
 * the service row itself, and an optional error sub-row. Every rendered row is
 * counted so the list never overflows past `maxRows` (F10).
 */
function rowHeight(
  status: ServiceStatus,
  index: number,
  statuses: ServiceStatus[],
  selectedIndex: number,
): number {
  const headerLines = getGroupHeader(status, index, statuses) ? 1 : 0;
  const errorLines = showsErrorSubRow(status, index === selectedIndex) ? 1 : 0;
  return headerLines + 1 + errorLines;
}

/**
 * Pick the contiguous range of service blocks to show. Grows outward from the
 * selected block (so it stays visible), reserving a line for each "N more"
 * indicator, until the line budget (`maxRows`) is spent.
 */
function computeWindow(
  heights: number[],
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  const n = heights.length;
  let start = selectedIndex;
  let end = selectedIndex + 1;
  let used = heights[selectedIndex] ?? 0;

  let grew = true;
  while (grew) {
    grew = false;
    const budget = maxRows - (start > 0 ? 1 : 0) - (end < n ? 1 : 0);
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

function renderRow(
  s: ServiceStatus,
  i: number,
  statuses: ServiceStatus[],
  selectedIndex: number,
  cols: number,
) {
  const groupHeader = getGroupHeader(s, i, statuses);
  const isGrouped = Boolean(s.group);

  return (
    <Box key={s.name} flexDirection="column">
      {groupHeader && (
        <Text dimColor>
          {"  "}
          {groupHeader}
        </Text>
      )}
      <ServiceRow status={s} isSelected={i === selectedIndex} cols={cols} indent={isGrouped} />
    </Box>
  );
}

export function ServiceList({ statuses, selectedIndex, maxRows, cols }: ServiceListProps) {
  const total = statuses.length;
  const heights = statuses.map((s, i) => rowHeight(s, i, statuses, selectedIndex));
  const totalLines = heights.reduce((sum, h) => sum + h, 0);

  if (maxRows === undefined || maxRows <= 0 || totalLines <= maxRows) {
    return (
      <Box flexDirection="column">
        {statuses.map((s, i) => renderRow(s, i, statuses, selectedIndex, cols))}
      </Box>
    );
  }

  const { start, end } = computeWindow(heights, selectedIndex, maxRows);
  const above = start;
  const below = total - end;
  const visible = statuses.slice(start, end);

  return (
    <Box flexDirection="column">
      {above > 0 && (
        <Text dimColor>
          {"  "}↑ {above} more
        </Text>
      )}
      {visible.map((s, i) => renderRow(s, i + start, statuses, selectedIndex, cols))}
      {below > 0 && (
        <Text dimColor>
          {"  "}↓ {below} more
        </Text>
      )}
    </Box>
  );
}
