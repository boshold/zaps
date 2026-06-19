import { Box } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { ActionHints } from "./ActionHints.js";
import { ColumnHeaders } from "./ColumnHeaders.js";
import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import { ServiceList } from "./ServiceList.js";
import { TaskHistorySection } from "./TaskHistorySection.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

interface DashboardProps {
  /** Pre-sorted in Router (single source of truth shared with the input handler, F8). */
  statuses: ServiceStatus[];
  selectedIndex: number;
  taskHistory: TaskRunRecord[];
}

export function Dashboard({ statuses, selectedIndex, taskHistory }: DashboardProps) {
  const { projectName, configStale } = useZaps();
  const { cols, rows, compact } = useDimensions();
  const width = Math.min(cols, 100);

  // Compute chrome rows to determine maxRows for service list
  // Normal: Header(2) + ColumnHeaders(2) + ActionHints(2) + HelpBar(1) = 7
  // Compact: Header(1) + HelpBar(1) = 2
  // The Recent Tasks section only renders when history exists (marginTop(1) +
  // Title(1) + up to `limit` rows); count it so the column never overflows the
  // Pane height and blanks the alternate-screen Ink frame.
  const recentTasksRows =
    !compact && taskHistory.length > 0 ? 2 + Math.min(taskHistory.length, 3) : 0;
  const chromeRows = (compact ? 2 : 7) + recentTasksRows;
  const maxRows = Math.max(1, rows - chromeRows);

  return (
    <Box height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={width}>
        <Header
          projectName={projectName}
          statuses={statuses}
          width={width}
          compact={compact}
          configStale={configStale}
        />
        {!compact && <ColumnHeaders cols={width} />}
        <ServiceList
          statuses={statuses}
          selectedIndex={selectedIndex}
          maxRows={maxRows}
          cols={width}
        />
        {!compact && <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} />}
        {!compact && <ActionHints status={statuses[selectedIndex]} />}
        <HelpBar compact={compact} status={statuses[selectedIndex]} />
      </Box>
    </Box>
  );
}
