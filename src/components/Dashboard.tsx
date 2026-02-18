import { useZaps } from "#src/hooks/useZaps.js";
import { relativeTime } from "#src/lib/relativeTime.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text, useStdout } from "ink";

import { ColumnHeaders } from "./ColumnHeaders.js";
import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import type { TaskRunRecord } from "./Router.js";
import { ServiceList } from "./ServiceList.js";

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
        {taskHistory.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              Recent Tasks
            </Text>
            {taskHistory.slice(0, 3).map((record) => (
              <Box key={`${record.taskKey}-${String(record.timestamp)}`} gap={1}>
                <Text color={record.result === "success" ? "green" : "red"}>
                  {record.result === "success" ? "✔" : "✖"}
                </Text>
                <Text>{record.taskName}</Text>
                <Text dimColor>{relativeTime(record.timestamp)}</Text>
              </Box>
            ))}
          </Box>
        )}
        <HelpBar />
      </Box>
    </Box>
  );
}
