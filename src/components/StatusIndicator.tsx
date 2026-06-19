import { Text } from "ink";
import { useEffect, useState } from "react";

import type { ServiceState } from "#src/lib/service/types.js";

import type { IconKey } from "./theme/icons.js";
import { useIcons } from "./theme/IconTheme.js";

const SPINNER_INTERVAL = 150;

const STATE_COLOR: Record<ServiceState, string> = {
  ready: "green",
  starting: "yellow",
  stopping: "yellow",
  restarting: "yellow",
  error: "red",
  stopped: "gray",
  unavailable: "gray",
};

const STATE_ICON: Record<ServiceState, IconKey> = {
  ready: "ready",
  starting: "working",
  stopping: "working",
  restarting: "working",
  error: "error",
  stopped: "stopped",
  unavailable: "unavailable",
};

function isSpinnerState(state: ServiceState): boolean {
  return state === "starting" || state === "stopping" || state === "restarting";
}

export function StatusIndicator({ state }: { state: ServiceState }) {
  const { icon, spinnerFrames } = useIcons();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isSpinnerState(state)) {
      return;
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(id);
    };
  }, [state, spinnerFrames.length]);

  // Reset frame when state changes
  useEffect(() => {
    setFrame(0);
  }, [state]);

  const color = STATE_COLOR[state];
  const symbol = isSpinnerState(state)
    ? spinnerFrames[frame % spinnerFrames.length]
    : icon(STATE_ICON[state]);

  return <Text color={color}>{symbol}</Text>;
}
