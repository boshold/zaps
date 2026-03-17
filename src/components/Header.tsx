import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

import { HeaderRow } from "./HeaderRow.js";

interface HeaderProps {
  projectName: string;
  statuses: ServiceStatus[];
  width: number;
  compact?: boolean;
}

export function Header({ projectName, statuses, width, compact }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <HeaderRow projectName={projectName} statuses={statuses} />
      {!compact && <Text dimColor>{"─".repeat(width)}</Text>}
    </Box>
  );
}
