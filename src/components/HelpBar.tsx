import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box, Text } from "ink";

interface HelpBarProps {
  compact?: boolean;
  status?: ServiceStatus;
}

export function HelpBar({ compact, status }: HelpBarProps) {
  if (compact && status) {
    // Compact: merge action hints + nav into one line
    return (
      <Box>
        <Text dimColor>[r]estart [s]top [t]asks [q]uit [d]own</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>[t]asks [a]ll restart [q]uit [d]own</Text>
    </Box>
  );
}
