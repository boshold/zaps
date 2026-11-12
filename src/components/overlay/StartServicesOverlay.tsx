import { Box, useInput } from "ink";
import { useEffect, useRef } from "react";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";

import { StartServicesBody } from "./StartServicesBody.js";
import type { StartServicesEntry } from "./StartServicesBody.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const START_SERVICES_ID = "start-services";

const POPUP_WIDTH = 60;

interface StartServicesOverlayProps {
  taskName: string;
  services: StartServicesEntry[];
  onConfirm: () => void;
  /** Called once when the overlay closes without confirmation (n, Esc, clear). */
  onCancel: () => void;
}

/**
 * Asks before starting the services a task needs. `y`/Enter confirms, `n`
 * cancels; Esc→pop is owned by `OverlayHost`, so cancel fires on unmount.
 */
function StartServicesOverlay({
  taskName,
  services,
  onConfirm,
  onCancel,
}: StartServicesOverlayProps) {
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();
  const confirmed = useRef(false);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(
    () => () => {
      if (!confirmed.current) {
        onCancelRef.current();
      }
    },
    [],
  );

  useInput(
    (input, key) => {
      if (input === "y" || input === "Y" || key.return) {
        confirmed.current = true;
        pop();
        onConfirm();
        return;
      }
      if (input === "n" || input === "N") {
        pop();
      }
    },
    { isActive: isTop(START_SERVICES_ID) },
  );

  const popupWidth = Math.min(POPUP_WIDTH, Math.max(20, cols - 2));
  const popupHeight = services.length + 6;
  const marginTop = Math.max(0, Math.floor((rows - popupHeight) / 2));
  const marginLeft = Math.max(0, Math.floor((cols - popupWidth) / 2));

  return (
    <Box
      position="absolute"
      marginTop={marginTop}
      marginLeft={marginLeft}
      width={popupWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      backgroundColor="default"
      paddingX={1}
    >
      <StartServicesBody taskName={taskName} services={services} />
    </Box>
  );
}

export { START_SERVICES_ID, StartServicesOverlay };
