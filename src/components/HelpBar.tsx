import { Box, Text } from "ink";

import { GLOBAL_HINTS } from "./hintText.js";

interface HelpBarProps {
  compact?: boolean;
  canControlSelected?: boolean;
}

export function HelpBar({ compact, canControlSelected }: HelpBarProps) {
  if (compact && canControlSelected !== undefined) {
    return (
      <Box>
        <Text dimColor>
          {canControlSelected ? "[r]estart [s]top " : ""}[t]asks [q]uit/detach [d]own
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>{GLOBAL_HINTS}</Text>
    </Box>
  );
}
