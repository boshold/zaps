import { Box } from "ink";

import { useViewport } from "#src/hooks/useViewport.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { ColumnHeaders } from "./ColumnHeaders.js";
import { DetailPane } from "./dashboard/DetailPane.js";
import { useViewportSize } from "./layout/ViewportContext.js";
import { ServiceList } from "./ServiceList.js";
import { TaskHistorySection } from "./TaskHistorySection.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { useIcons } from "./theme/IconTheme.js";

interface DashboardSplitProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  /** Width of the left (list) column. */
  listCols: number;
  /** Width of the right (detail) column. */
  detailWidth: number;
  taskHistory: TaskRunRecord[];
}

/**
 * Wide-layout body: a true left/right pane split. The left column stacks the
 * column headers, the windowed service list and Recent Tasks; a continuous
 * full-height vertical divider separates it from the detail pane on the right.
 *
 * The divider is a 1-col Box whose left edge is the only rendered border (char
 * from the icon tier so the ascii 7-bit invariant holds), pinned to the measured
 * body height. The tee junctions that make it read as a pane frame (`┬`/`┴`) live
 * in the header rule above the body and the footer rule below it ({@link Header},
 * {@link Dashboard}), so the line merges into both rules rather than floating with
 * detached caps.
 *
 * The service list can't use the full body height (Recent Tasks + headers share
 * the column), so its own region is measured with {@link useViewport} and that
 * height drives the windowing — never arithmetic (the v1 chromeRows bug).
 */
export function DashboardSplit({
  statuses,
  selectedIndex,
  listCols,
  detailWidth,
  taskHistory,
}: DashboardSplitProps) {
  const { height } = useViewportSize();
  const { icon } = useIcons();
  // `height` is a dep so the list re-measures when the body shrinks/grows (e.g. a
  // Reserved-row toast). Without it the window stays stale until the next keypress
  // Changes `selectedIndex` — the "+N more" marker would only appear after up/down.
  const listView = useViewport([height, statuses.length, selectedIndex, taskHistory.length]);

  // Left-edge-only custom border: every other edge is an inert blank so the
  // Single vertical line is all that renders. Gray (not just dim) per request.
  const lineStyle = {
    topLeft: " ",
    top: " ",
    topRight: " ",
    right: " ",
    bottomRight: " ",
    bottom: " ",
    bottomLeft: " ",
    left: icon("treeBranch"),
  };

  // The list region is the only shrinkable child — the headers and Recent Tasks
  // Are pinned (flexShrink 0) so Yoga never steals their rows (e.g. the "Recent
  // Tasks" title) when the column overflows; the list windows + clips instead.
  const headers = (
    <Box flexShrink={0}>
      <ColumnHeaders cols={listCols} />
    </Box>
  );

  const listRegion = (
    <Box ref={listView.ref} flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
      <ServiceList
        statuses={statuses}
        selectedIndex={selectedIndex}
        maxRows={listView.height}
        cols={listCols}
        detailVisible
      />
    </Box>
  );

  const recentTasks = (
    <Box flexShrink={0}>
      <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} width={listCols} />
    </Box>
  );

  const leftColumn = (
    <Box width={listCols} flexShrink={0} flexDirection="column">
      {headers}
      {listRegion}
      {recentTasks}
    </Box>
  );

  const divider = (
    <Box
      height={height}
      flexShrink={0}
      borderStyle={lineStyle}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor="gray"
    />
  );

  return (
    <Box flexDirection="row" height={height}>
      {leftColumn}
      {divider}
      <DetailPane status={statuses[selectedIndex]} width={detailWidth} maxLines={height} />
    </Box>
  );
}
