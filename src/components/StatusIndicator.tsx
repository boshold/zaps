import { Text } from "ink";
import { useEffect, useState } from "react";

import type { ServiceState } from "#src/lib/service/types.js";

const SPINNER_FRAMES = ["◐", "◑", "◒", "◓"];
const SPINNER_INTERVAL = 150;

const STATUS_MAP: Record<ServiceState, { symbol: string; color: string }> = {
  ready: { symbol: "●", color: "green" },
  starting: { symbol: "◐", color: "yellow" },
  stopping: { symbol: "◐", color: "yellow" },
  restarting: { symbol: "◐", color: "yellow" },
  error: { symbol: "✖", color: "red" },
  stopped: { symbol: "○", color: "gray" },
  unavailable: { symbol: "○", color: "gray" },
};

function isSpinnerState(state: ServiceState): boolean {
  return state === "starting" || state === "stopping" || state === "restarting";
}

export function StatusIndicator({ state }: { state: ServiceState }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isSpinnerState(state)) {
      return;
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(id);
    };
  }, [state]);

  // Reset frame when state changes
  useEffect(() => {
    setFrame(0);
  }, [state]);

  const { color } = STATUS_MAP[state];
  const symbol = isSpinnerState(state) ? SPINNER_FRAMES[frame] : STATUS_MAP[state].symbol;

  return <Text color={color}>{symbol}</Text>;
}
