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

export function ServiceList({ statuses, selectedIndex, maxRows, cols }: ServiceListProps) {
  const total = statuses.length;

  if (maxRows === undefined || maxRows <= 0 || total <= maxRows) {
    return (
      <Box flexDirection="column">
        {statuses.map((s, i) => (
          <ServiceRow key={s.name} status={s} isSelected={i === selectedIndex} cols={cols} />
        ))}
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
  const visible = statuses.slice(adjOffset, adjOffset + visibleCount);

  return (
    <Box flexDirection="column">
      {above > 0 && (
        <Text dimColor>
          {"  "}↑ {above} more
        </Text>
      )}
      {visible.map((s, i) => (
        <ServiceRow
          key={s.name}
          status={s}
          isSelected={i + adjOffset === selectedIndex}
          cols={cols}
        />
      ))}
      {below > 0 && (
        <Text dimColor>
          {"  "}↓ {below} more
        </Text>
      )}
    </Box>
  );
}
