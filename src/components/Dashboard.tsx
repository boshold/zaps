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
  statuses: ServiceStatus[];
  selectedIndex: number;
  taskHistory: TaskRunRecord[];
}

export function Dashboard({ statuses, selectedIndex, taskHistory }: DashboardProps) {
  const { projectName, configStale } = useZaps();
  const { cols, rows, compact } = useDimensions();
  const width = Math.min(cols, 100);

  // Sort unavailable services to bottom so index is consistent across all components
  const sorted = [
    ...statuses.filter((s) => s.state !== "unavailable"),
    ...statuses.filter((s) => s.state === "unavailable"),
  ];

  // Compute chrome rows to determine maxRows for service list
  // Normal: Header(2) + ColumnHeaders(2) + ActionHints(2) + HelpBar(1) = 7
  // Compact: Header(1) + HelpBar(1) = 2
  const chromeRows = compact ? 2 : 7;
  const maxRows = Math.max(1, rows - chromeRows);

  return (
    <Box height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={width}>
        <Header
          projectName={projectName}
          statuses={sorted}
          width={width}
          compact={compact}
          configStale={configStale}
        />
        {!compact && <ColumnHeaders cols={width} />}
        <ServiceList
          statuses={sorted}
          selectedIndex={selectedIndex}
          maxRows={maxRows}
          cols={width}
        />
        {!compact && <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} />}
        {!compact && <ActionHints status={sorted[selectedIndex]} />}
        <HelpBar compact={compact} status={sorted[selectedIndex]} />
      </Box>
    </Box>
  );
}
