import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

export function ActionHints({ status }: { status?: ServiceStatus }) {
  if (status?.state === "unavailable") {
    return (
      <Box marginTop={1}>
        <Text dimColor>Service not available on this system</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {status
          ? `[r]estart [s]top [l]ogs [z]oom [Z]aps zoom [E]dit [c]onfig${status.url ? " [o]pen" : ""}${status.isDocker ? " [R]ebuild" : ""}`
          : ""}
      </Text>
    </Box>
  );
}
