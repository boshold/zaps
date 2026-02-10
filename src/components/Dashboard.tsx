import type { ServiceStatus } from "../lib/service/types.js";
import { Box } from "ink";

import { useZaps } from "../hooks/useZaps.js";

import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import { ServiceRow } from "./ServiceRow.js";

interface DashboardProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
}

export function Dashboard({ statuses, selectedIndex }: DashboardProps) {
  const { config } = useZaps();

  return (
    <Box flexDirection="column" padding={1}>
      <Header projectName={config.project.name} />
      <Box flexDirection="column" marginTop={1}>
        {statuses.map((s, i) => (
          <ServiceRow key={s.name} status={s} isSelected={i === selectedIndex} />
        ))}
      </Box>
      <HelpBar />
    </Box>
  );
}
