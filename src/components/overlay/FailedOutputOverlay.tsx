import { Box, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import type { TaskOutputSnapshot } from "#src/daemon/task-output-store.js";
import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import { useZaps } from "#src/hooks/useZaps.js";

import { FailedOutputBody } from "./FailedOutputBody.js";
import type { FailedOutputState } from "./FailedOutputBody.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const FAILED_OUTPUT_ID = "failed-output";

interface FailedOutputOverlayProps {
  runId: string;
  taskName: string;
  /** Fetch the retained run buffer (Router injects `client.getTaskOutput`). */
  fetchOutput: (runId: string) => Promise<TaskOutputSnapshot>;
  showPopup: (runId: string) => void;
  /** Called once on close (Esc → pop → unmount) to acknowledge the sticky toast. */
  onClose: () => void;
}

/**
 * Failed-output viewer hosted on the overlay stack. Fetches the run's retained
 * output via the injected `fetchOutput`, windows it with `ScrollableList`, and
 * offers `p` to escalate into a larger `tmux display-popup` (Q3). It does NOT
 * bind Esc — `OverlayHost` owns Esc→pop; this component acknowledges the sticky
 * failure on unmount via `onClose`. `not_found` (evicted) degrades to a message.
 */
function FailedOutputOverlay({
  runId,
  taskName,
  fetchOutput,
  showPopup,
  onClose,
}: FailedOutputOverlayProps) {
  const { cols, rows } = useDimensions();
  const { isTop } = useOverlay();
  const { capabilities } = useZaps();
  const [state, setState] = useState<FailedOutputState>("loading");
  const [lines, setLines] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Acknowledge exactly once on unmount, reading the latest onClose via a ref so
  // A changed callback identity can't retrigger the effect (or ack early).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => () => onCloseRef.current(), []);

  // Fetch the buffer on open. A cancelled flag guards against setState after
  // Unmount (the overlay can be popped while the request is in flight).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await fetchOutput(runId);
        if (cancelled) {
          return;
        }
        setLines(snapshot.lines);
        // Anchor to the tail — the failure is usually at the end of the output.
        setSelectedIndex(Math.max(0, snapshot.lines.length - 1));
        setState("ready");
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        setState(error instanceof Error && error.message === "not_found" ? "not_found" : "error");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, fetchOutput]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((i) => Math.min(Math.max(0, lines.length - 1), i + 1));
        return;
      }
      if (input === "p" && state === "ready" && capabilities.popups) {
        showPopup(runId);
      }
    },
    { isActive: isTop(FAILED_OUTPUT_ID) },
  );

  const width = Math.min(100, Math.max(24, cols - 4));
  const height = Math.max(8, rows - 4);
  const marginLeft = Math.max(0, Math.floor((cols - width) / 2));
  const marginTop = Math.max(0, Math.floor((rows - height) / 2));
  // List budget = popup height minus title (1) + spacer (1) + hint (1) + border (2).
  const maxHeight = Math.max(3, height - 5);

  return (
    <Box
      position="absolute"
      marginTop={marginTop}
      marginLeft={marginLeft}
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      backgroundColor="default"
      paddingX={1}
    >
      <FailedOutputBody
        taskName={taskName}
        state={state}
        lines={lines}
        selectedIndex={selectedIndex}
        maxHeight={maxHeight}
        canEscalate={state === "ready" && capabilities.popups}
      />
    </Box>
  );
}

export { FAILED_OUTPUT_ID, FailedOutputOverlay };
export type { FailedOutputOverlayProps };
