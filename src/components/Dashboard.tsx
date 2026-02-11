import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";
import { Box, useStdout } from "ink";

import { ColumnHeaders } from "./ColumnHeaders.js";
import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import { ServiceList } from "./ServiceList.js";

interface DashboardProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  chordMode?: boolean;
}

export function Dashboard({ statuses, selectedIndex, chordMode }: DashboardProps) {
  const { config } = useZaps();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = Math.min(stdout?.columns ?? 100, 100);
  const taskShortcuts = chordMode ? getTaskShortcuts(config.project.tasks ?? {}) : [];

  return (
    <Box height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={cols}>
        <Header projectName={config.project.name} statuses={statuses} width={cols} />
        <ColumnHeaders />
        <ServiceList statuses={statuses} selectedIndex={selectedIndex} />
        <HelpBar chordMode={chordMode} taskShortcuts={taskShortcuts} />
      </Box>
    </Box>
  );
}
