import { Box, Text } from "ink";

import type { BackendId } from "#src/lib/backend/types.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { StatusSummary } from "./StatusSummary.js";
import { useIcons } from "./theme/IconTheme.js";

interface HeaderRowProps {
  projectName: string;
  backend?: BackendId;
  statuses: ServiceStatus[];
  configStale?: boolean;
}

export function HeaderRow({ projectName, backend, statuses, configStale }: HeaderRowProps) {
  const { icon } = useIcons();
  return (
    <Box>
      <Text bold color="cyan">
        {icon("logo")} zaps:{" "}
      </Text>
      <Text bold>{projectName}</Text>
      {backend && <Text color="gray">{` [${backend}]`}</Text>}
      {configStale && (
        <Text color="yellow">{`  config changed ${icon("dash")} press c to reload`}</Text>
      )}
      <Box flexGrow={1} justifyContent="flex-end">
        <StatusSummary statuses={statuses} />
      </Box>
    </Box>
  );
}
