import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { HeaderRow } from "./HeaderRow.js";
import { useIcons } from "./theme/IconTheme.js";

interface HeaderProps {
  projectName: string;
  statuses: ServiceStatus[];
  width: number;
  compact?: boolean;
  configStale?: boolean;
}

export function Header({ projectName, statuses, width, compact, configStale }: HeaderProps) {
  const { icon } = useIcons();
  return (
    <Box flexDirection="column">
      <HeaderRow projectName={projectName} statuses={statuses} configStale={configStale} />
      {!compact && <Text dimColor>{icon("divider").repeat(width)}</Text>}
    </Box>
  );
}
