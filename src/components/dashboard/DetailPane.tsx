import { Box, Text } from "ink";

import { useIcons } from "#src/components/theme/IconTheme.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { DetailField } from "./DetailField.js";

interface DetailPaneProps {
  status?: ServiceStatus;
  width: number;
}

function formatUptime(readySince: number | undefined): string {
  if (typeof readySince !== "number") {
    return "n/a";
  }
  const diff = Math.floor((Date.now() - readySince) / 1000);
  if (diff < 60) {
    return `${diff}s`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m`;
  }
  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Right-hand detail pane for the selected service, shown only on wide terminals
 * (`cols >= ui.wideThreshold`). Renders the available `ServiceStatus` fields,
 * gracefully showing `n/a` for anything absent.
 */
export function DetailPane({ status, width }: DetailPaneProps) {
  const { icon } = useIcons();
  // Vertical divider drawn as the themed tree-branch glyph (│ nerd / | ascii) at
  // The start of every rendered line, rather than an Ink border — an Ink border
  // Renders box-drawing chars unconditionally, which would break the ascii tier's
  // 7-bit invariant (glyphsByTier.test). Per-line prefixing also matches the
  // Content height exactly without measuring the flexed body.
  const bar = icon("treeBranch");

  if (!status) {
    return (
      <Box width={width} flexDirection="column">
        <Text dimColor>{`${bar} No service selected`}</Text>
      </Box>
    );
  }

  const fields: { label: string; value: string }[] = [
    { label: "state", value: status.state },
    { label: "uptime", value: formatUptime(status.readySince) },
    { label: "pid", value: typeof status.pid === "number" ? String(status.pid) : "n/a" },
    {
      label: "ports",
      value: status.ports.length > 0 ? status.ports.map((p) => `:${p}`).join(" ") : "n/a",
    },
    { label: "url", value: status.url ?? "n/a" },
    ...(status.group ? [{ label: "group", value: status.group }] : []),
    { label: "docker", value: status.isDocker ? `${icon("docker")} yes` : "no" },
    { label: "retries", value: String(status.retryCount) },
  ];

  return (
    <Box width={width} flexDirection="column">
      <Box>
        <Text dimColor>{`${bar} `}</Text>
        <Text bold>{status.name}</Text>
      </Box>
      <Text dimColor>{bar}</Text>
      {fields.map((f) => (
        <Box key={f.label}>
          <Text dimColor>{`${bar} `}</Text>
          <DetailField label={f.label} value={f.value} />
        </Box>
      ))}
      {status.lastError ? (
        <Box>
          <Text dimColor>{`${bar} `}</Text>
          <DetailField label="error" value={status.lastError} color="red" />
        </Box>
      ) : null}
    </Box>
  );
}
