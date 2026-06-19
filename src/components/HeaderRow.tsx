import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { StatusSummary } from "./StatusSummary.js";
import { useIcons } from "./theme/IconTheme.js";

interface HeaderRowProps {
  projectName: string;
  statuses: ServiceStatus[];
  configStale?: boolean;
}

export function HeaderRow({ projectName, statuses, configStale }: HeaderRowProps) {
  const { icon } = useIcons();
  return (
    <Box>
      <Text bold color="cyan">
        {icon("logo")} zaps:{" "}
      </Text>
      <Text bold>{projectName}</Text>
      {configStale && (
        <Text color="yellow">{`  config changed ${icon("dash")} press c to reload`}</Text>
      )}
      <Box flexGrow={1} justifyContent="flex-end">
        <StatusSummary statuses={statuses} />
      </Box>
    </Box>
  );
}
