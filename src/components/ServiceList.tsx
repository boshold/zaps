import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

import { ServiceRow } from "./ServiceRow.js";

interface ServiceListProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  maxRows?: number;
  cols: number;
}

function computeScrollOffset(selectedIndex: number, total: number, maxRows: number): number {
  if (total <= maxRows) {
    return 0;
  }
  const half = Math.floor(maxRows / 2);
  return Math.max(0, Math.min(selectedIndex - half, total - maxRows));
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
  // Sort unavailable services to bottom
  const sorted = [
    ...statuses.filter((s) => s.state !== "unavailable"),
    ...statuses.filter((s) => s.state === "unavailable"),
  ];
  const total = sorted.length;

  if (maxRows === undefined || maxRows <= 0 || total <= maxRows) {
    return (
      <Box flexDirection="column">
        {sorted.map((s, i) => renderRow(s, i, sorted, selectedIndex, cols))}
      </Box>
    );
  }

  // Reserve rows for scroll indicators when needed
  const offset = computeScrollOffset(selectedIndex, total, maxRows);
  const hasAbove = offset > 0;
  const hasBelow = offset + maxRows < total;
  const indicatorRows = (hasAbove ? 1 : 0) + (hasBelow ? 1 : 0);
  const visibleCount = Math.max(1, maxRows - indicatorRows);

  // Recompute offset with adjusted visible count
  const adjOffset = computeScrollOffset(selectedIndex, total, visibleCount);
  const above = adjOffset;
  const below = total - adjOffset - visibleCount;
  const visible = sorted.slice(adjOffset, adjOffset + visibleCount);

  return (
    <Box flexDirection="column">
      {above > 0 && (
        <Text dimColor>
          {"  "}↑ {above} more
        </Text>
      )}
      {visible.map((s, i) => renderRow(s, i + adjOffset, sorted, i + adjOffset, cols))}
      {below > 0 && (
        <Text dimColor>
          {"  "}↓ {below} more
        </Text>
      )}
    </Box>
  );
}
