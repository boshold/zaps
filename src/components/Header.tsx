import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

import { HeaderRow } from "./HeaderRow.js";

interface HeaderProps {
  projectName: string;
  statuses: ServiceStatus[];
  width: number;
}

export function Header({ projectName, statuses, width }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <HeaderRow projectName={projectName} statuses={statuses} />
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}
