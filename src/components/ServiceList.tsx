import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { ScrollableList } from "./layout/ScrollableList.js";
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
 * counted so the list never overflows past the budget (F10).
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

function renderRow(
  s: ServiceStatus,
  i: number,
  statuses: ServiceStatus[],
  isSelected: boolean,
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
      <ServiceRow status={s} isSelected={isSelected} cols={cols} indent={isGrouped} />
    </Box>
  );
}

export function ServiceList({ statuses, selectedIndex, maxRows, cols }: ServiceListProps) {
  // Windowing (grow-from-selected + overflow markers + multi-line rows) lives in the
  // Reusable ScrollableList; ServiceList only contributes its row rendering and
  // The service-specific row-height (group headers + error sub-rows).
  return (
    <ScrollableList
      items={statuses}
      selectedIndex={selectedIndex}
      maxHeight={maxRows ?? 0}
      rowHeight={(s, i) => rowHeight(s, i, statuses, selectedIndex)}
      renderItem={(s, i, selected) => renderRow(s, i, statuses, selected, cols)}
    />
  );
}
