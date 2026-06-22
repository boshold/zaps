import { Box, Text } from "ink";

import { EMPTY_STATE_MESSAGES } from "./states/messages.js";
import { useIcons } from "./theme/IconTheme.js";

/**
 * Sticky top banner shown when the daemon connection is lost. `r` re-attaches,
 * `q` quits/detaches (handled by Router while disconnected). Colored AND labelled so the
 * signal survives low-color / ascii terminals (no color-only signaling); the
 * separators resolve through the theme so the ascii tier stays 7-bit.
 */
export function DisconnectBanner() {
  const { icon } = useIcons();
  return (
    <Box>
      <Text bold color="red">
        {`${EMPTY_STATE_MESSAGES.disconnected} ${icon("dash")} r retry ${icon("dot")} q quit/detach`}
      </Text>
    </Box>
  );
}
