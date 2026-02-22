import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

import { ErrorSubRow } from "./ErrorSubRow.js";
import { StatusCell } from "./StatusCell.js";

interface ServiceRowProps {
  status: ServiceStatus;
  isSelected: boolean;
}

function formatPorts(ports: number[]): string {
  if (ports.length === 0) {
    return ":----";
  }
  return ports.map((p) => `:${p}`).join(" ");
}

function formatUptime(readySince: number | undefined): string {
  if (typeof readySince !== "number") {
    return "ready";
  }
  const diff = Math.floor((Date.now() - readySince) / 1000);
  if (diff < 60) {
    return `Up ${diff}s`;
  }
  if (diff < 3600) {
    return `Up ${Math.floor(diff / 60)}m`;
  }
  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  return mins > 0 ? `Up ${hours}h ${mins}m` : `Up ${hours}h`;
}

function stateLabel(status: ServiceStatus): string {
  if (status.state === "ready") {
    return formatUptime(status.readySince);
  }
  return status.state;
}

export function ServiceRow({ status, isSelected }: ServiceRowProps) {
  const portsStr = formatPorts(status.ports);

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{isSelected ? "> " : "  "}</Text>
        <StatusCell status={status} />
        <Text> </Text>
        <Text bold={isSelected}>{status.name.padEnd(16)}</Text>
        <Text>{stateLabel(status).padEnd(10)}</Text>
        <Text dimColor>{portsStr.padEnd(12)}</Text>
        <Text dimColor>
          {(status.url ?? (status.retryCount > 0 ? `retry ${status.retryCount}` : "")).padEnd(24)}
        </Text>
        <Text dimColor>
          {(isSelected
            ? `[r]estart [s]top [l]ogs${status.url ? " [o]pen" : ""}${status.isDocker ? " [R]ebuild" : ""}`
            : ""
          ).padEnd(28)}
        </Text>
      </Box>
      {isSelected && status.lastError && <ErrorSubRow error={status.lastError} />}
    </Box>
  );
}
