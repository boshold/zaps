// eslint-disable-next-line import/no-relative-parent-imports -- Components need service types
import type { ServiceStatus } from "../lib/service/types.js";
import { Box, Text } from "ink";

import { StatusIndicator } from "./StatusIndicator.js";

export function ServiceRow({ status, isSelected }: { status: ServiceStatus; isSelected: boolean }) {
  const portStr = status.ports.length > 0 ? `:${status.ports[0]}` : ":---";

  return (
    <Box>
      <Text>{isSelected ? ">" : " "} </Text>
      <StatusIndicator state={status.state} />
      <Text> </Text>
      <Text bold={isSelected}>{status.name.padEnd(16)}</Text>
      <Text dimColor>{portStr.padEnd(8)}</Text>
      <Text dimColor> [r] [s]</Text>
    </Box>
  );
}
