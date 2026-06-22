import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

interface HelpBarProps {
  compact?: boolean;
  status?: ServiceStatus;
}

export function HelpBar({ compact, status }: HelpBarProps) {
  const isUnavailable = status?.state === "unavailable";
  if (compact && status && !isUnavailable) {
    // Compact: merge action hints + nav into one line
    return (
      <Box>
        <Text dimColor>[r]estart [s]top [t]asks [q]uit/detach [d] down</Text>
      </Box>
    );
  }
  if (compact && isUnavailable) {
    return (
      <Box>
        <Text dimColor>[t]asks [q]uit/detach [d] down</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>[t]asks [a]ll restart [q]uit/detach [d] down</Text>
    </Box>
  );
}
