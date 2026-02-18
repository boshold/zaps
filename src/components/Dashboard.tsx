import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, useStdout } from "ink";

import { ColumnHeaders } from "./ColumnHeaders.js";
import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import { ServiceList } from "./ServiceList.js";
import { TaskHistorySection } from "./TaskHistorySection.js";

interface DashboardProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  taskHistory: TaskRunRecord[];
}

export function Dashboard({ statuses, selectedIndex, taskHistory }: DashboardProps) {
  const { config } = useZaps();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = Math.min(stdout?.columns ?? 100, 100);

  return (
    <Box height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={cols}>
        <Header projectName={config.project.name} statuses={statuses} width={cols} />
        <ColumnHeaders />
        <ServiceList statuses={statuses} selectedIndex={selectedIndex} />
        <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} />
        <HelpBar />
      </Box>
    </Box>
  );
}
