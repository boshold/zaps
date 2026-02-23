import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

export function ActionHints({ status }: { status?: ServiceStatus }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {status
          ? `[r]estart [s]top [l]ogs [P]opout${status.url ? " [o]pen" : ""}${status.isDocker ? " [R]ebuild" : ""}`
          : ""}
      </Text>
    </Box>
  );
}
