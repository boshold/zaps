import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { StatusSummary } from "./StatusSummary.js";

interface HeaderRowProps {
  projectName: string;
  statuses: ServiceStatus[];
}

export function HeaderRow({ projectName, statuses }: HeaderRowProps) {
  return (
    <Box>
      <Text bold color="cyan">
        ⚡ zaps:{" "}
      </Text>
      <Text bold>{projectName}</Text>
      <Box flexGrow={1} justifyContent="flex-end">
        <StatusSummary statuses={statuses} />
      </Box>
    </Box>
  );
}
