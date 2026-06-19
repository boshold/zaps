import { Box, Text } from "ink";

import { EMPTY_STATE_MESSAGES } from "./states/messages.js";

/**
 * Sticky top banner shown when the daemon connection is lost. `r` re-attaches,
 * `q` quits (handled by Router while disconnected). Colored AND labelled so the
 * signal survives low-color / ascii terminals (no color-only signaling).
 */
export function DisconnectBanner() {
  return (
    <Box>
      <Text bold color="red">
        {EMPTY_STATE_MESSAGES.disconnected}
      </Text>
    </Box>
  );
}
