import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { ErrorSubRow } from "./ErrorSubRow.js";
import { showsErrorSubRow } from "./serviceRowError.js";
import { StatusCell } from "./StatusCell.js";

interface ServiceRowProps {
  status: ServiceStatus;
  isSelected: boolean;
  cols: number;
  indent?: boolean;
}

function formatPorts(ports: number[]): string {
  if (ports.length === 0) {
    return "-";
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
  if (status.state === "unavailable") {
    return "n/a";
  }
  if (status.state === "ready") {
    return formatUptime(status.readySince);
  }
  return status.state;
}

/**
 * Trailing info cell for the wide layout: a `detached` marker for pane-less
 * services (E4) alongside any url / retry text.
 */
function trailingInfo(status: ServiceStatus): string {
  const base = status.url ?? (status.retryCount > 0 ? `retry ${status.retryCount}` : "");
  if (status.isDetached) {
    return base ? `detached ${base}` : "detached";
  }
  return base;
}

// 4 chars: selector(2) + status(1) + space(1)
const PREFIX_WIDTH = 4;
const INDENT_WIDTH = 2;

export function ServiceRow({ status, isSelected, cols, indent }: ServiceRowProps) {
  const dim = status.state === "unavailable";
  const bold = isSelected && !dim;
  const portsStr = formatPorts(status.ports);
  const indentStr = indent ? "  " : "";
  const effectiveCols = indent ? cols - INDENT_WIDTH : cols;
  const available = effectiveCols - PREFIX_WIDTH;

  // Cols >= 80: NAME(24) STATUS(10) PORTS(24) URL(rest)
  // Cols >= 50: NAME(20) STATUS(10) PORTS(rest)
  // Cols >= 30: NAME(rest) STATUS(8)
  // Cols < 30:  NAME only (truncated)

  if (effectiveCols >= 80) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text>{indentStr}</Text>
          <Text>{isSelected ? "> " : "  "}</Text>
          <StatusCell status={status} />
          <Text> </Text>
          <Text bold={bold} dimColor={dim}>
            {status.name.padEnd(24)}
          </Text>
          <Text dimColor={dim}>{stateLabel(status).padEnd(10)}</Text>
          <Text dimColor>{portsStr.padEnd(24)}</Text>
          <Text dimColor wrap="truncate">
            {trailingInfo(status).padEnd(Math.max(0, available - 24 - 10 - 24))}
          </Text>
        </Box>
        {status.lastError && showsErrorSubRow(status, isSelected) && (
          <ErrorSubRow error={status.lastError} />
        )}
      </Box>
    );
  }

  if (effectiveCols >= 50) {
    const nameWidth = 20;
    const statusWidth = 10;
    return (
      <Box flexDirection="column">
        <Box>
          <Text>{indentStr}</Text>
          <Text>{isSelected ? "> " : "  "}</Text>
          <StatusCell status={status} />
          <Text> </Text>
          <Text bold={bold} dimColor={dim}>
            {status.name.padEnd(nameWidth)}
          </Text>
          <Text dimColor={dim}>{stateLabel(status).padEnd(statusWidth)}</Text>
          <Text dimColor wrap="truncate">
            {status.isDetached ? `detached ${portsStr}` : portsStr}
          </Text>
        </Box>
        {status.lastError && showsErrorSubRow(status, isSelected) && (
          <ErrorSubRow error={status.lastError} />
        )}
      </Box>
    );
  }

  if (effectiveCols >= 30) {
    const statusWidth = 8;
    const nameWidth = Math.max(4, available - statusWidth);
    return (
      <Box flexDirection="column">
        <Box>
          <Text>{indentStr}</Text>
          <Text>{isSelected ? "> " : "  "}</Text>
          <StatusCell status={status} />
          <Text> </Text>
          <Text bold={bold} dimColor={dim}>
            {status.name.slice(0, nameWidth).padEnd(nameWidth)}
          </Text>
          <Text dimColor={dim} wrap="truncate">
            {stateLabel(status).slice(0, statusWidth)}
          </Text>
        </Box>
        {status.lastError && showsErrorSubRow(status, isSelected) && (
          <ErrorSubRow error={status.lastError} />
        )}
      </Box>
    );
  }

  // Tiny: name only
  const nameWidth = Math.max(1, available);
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{indentStr}</Text>
        <Text>{isSelected ? "> " : "  "}</Text>
        <StatusCell status={status} />
        <Text> </Text>
        <Text bold={bold} dimColor={dim} wrap="truncate">
          {status.name.slice(0, nameWidth)}
        </Text>
      </Box>
    </Box>
  );
}
