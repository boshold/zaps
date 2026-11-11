import { Box, Text } from "ink";

import { EMPTY_STATE_MESSAGES } from "./states/messages.js";
import { useIcons } from "./theme/IconTheme.js";

export function DisconnectBanner({ canQuitOffline }: { canQuitOffline: boolean }) {
  const { icon } = useIcons();
  const quitHint = canQuitOffline ? "q quit" : "Detach tmux manually";
  return (
    <Box>
      <Text bold color="red">
        {`${EMPTY_STATE_MESSAGES.disconnected} ${icon("dash")} r retry ${icon("dot")} ${quitHint}`}
      </Text>
    </Box>
  );
}
