import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, useStdout } from "ink";

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
  const { projectName } = useZaps();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = Math.min(stdout?.columns ?? 100, 100);

  return (
    <Box height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={cols}>
        <Header projectName={projectName} statuses={statuses} width={cols} />
        <ColumnHeaders />
        <ServiceList statuses={statuses} selectedIndex={selectedIndex} />
        <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} />
        <ActionHints status={statuses[selectedIndex]} />
        <HelpBar />
      </Box>
    </Box>
  );
}
