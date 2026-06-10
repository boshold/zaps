import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

function stateColor(state: string): string {
  switch (state) {
    case "ready": {
      return "green";
    }
    case "starting":
    case "restarting":
    case "stopping": {
      return "yellow";
    }
    case "error": {
      return "red";
    }
    case "unavailable": {
      return "gray";
    }
    default: {
      return "gray";
    }
  }
}

export function StatusSummary({ statuses }: { statuses: ServiceStatus[] }) {
  const counts: Record<string, { count: number; color: string }> = {};
  const filtered = statuses.filter((s) => s.state !== "unavailable");
  for (const s of filtered) {
    const entry = counts[s.state];
    if (entry) {
      entry.count += 1;
    } else {
      counts[s.state] = { count: 1, color: stateColor(s.state) };
    }
  }

  const parts = Object.entries(counts);
  return (
    <Box gap={1}>
      {parts.map(([state, { count, color }]) => (
        <Text key={state} color={color}>
          {count} {state}
        </Text>
      ))}
    </Box>
  );
}
