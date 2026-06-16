import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { StatusSummary } from "./StatusSummary.js";

interface HeaderRowProps {
  projectName: string;
  statuses: ServiceStatus[];
  configStale?: boolean;
}

export function HeaderRow({ projectName, statuses, configStale }: HeaderRowProps) {
  return (
    <Box>
      <Text bold color="cyan">
        ⚡ zaps:{" "}
      </Text>
      <Text bold>{projectName}</Text>
      {configStale && <Text color="yellow">{"  config changed — press c to reload"}</Text>}
      <Box flexGrow={1} justifyContent="flex-end">
        <StatusSummary statuses={statuses} />
      </Box>
    </Box>
  );
}
