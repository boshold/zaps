import { Box, Text, useInput } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const SHUTDOWN_CONFIRM_ID = "shutdown-confirm";

const POPUP_WIDTH = 54;
const POPUP_HEIGHT = 7;

interface ShutdownConfirmOverlayProps {
  /** Runs the actual `session.destroy` (with its own busy guard) in the Router. */
  onConfirm: () => void;
}

/**
 * Confirmation gate in front of session shutdown (`Ctrl-D`, dashboard `d`, the
 * palette's "Shut down session").
 *
 * Shutdown stops every service and destroys the session — irreversible, and
 * previously one keystroke away. A tmux pane's stdin is not a trusted source of
 * user intent: any client can push bytes into it, and a client whose own stdin
 * is at EOF makes the pty emit `VEOF` (`0x04`) on attach, which tmux forwards to
 * the pane as a plain Ctrl-D. So a single byte tore the whole session down with
 * nobody asking for it. Requiring a second, distinct key (`y`) means no single
 * stray byte can be destructive, whatever its source.
 *
 * `y` confirms; every other key cancels (Esc→pop is owned by `OverlayHost`).
 * Enter deliberately does NOT confirm — `\r` is exactly the kind of byte that
 * arrives unsolicited.
 */
function ShutdownConfirmOverlay({ onConfirm }: ShutdownConfirmOverlayProps) {
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();

  useInput(
    (input) => {
      if (input === "y" || input === "Y") {
        pop();
        onConfirm();
        return;
      }
      pop();
    },
    { isActive: isTop(SHUTDOWN_CONFIRM_ID) },
  );

  const popupWidth = Math.min(POPUP_WIDTH, Math.max(20, cols - 2));
  const marginTop = Math.max(0, Math.floor((rows - POPUP_HEIGHT) / 2));
  const marginLeft = Math.max(0, Math.floor((cols - popupWidth) / 2));

  return (
    <Box
      position="absolute"
      marginTop={marginTop}
      marginLeft={marginLeft}
      width={popupWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      backgroundColor="default"
      paddingX={1}
    >
      <Text bold color="red">
        Shut down session?
      </Text>
      <Box marginTop={1}>
        <Text>Stops every service and destroys the session.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[y] shut down [esc] cancel</Text>
      </Box>
    </Box>
  );
}

export { SHUTDOWN_CONFIRM_ID, ShutdownConfirmOverlay };
