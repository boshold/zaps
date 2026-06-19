import { Text } from "ink";
import { useEffect, useState } from "react";

import { useIcons } from "#src/components/theme/IconTheme.js";

export interface SpinnerProps {
  /** Optional text shown to the right of the spinner glyph. */
  label?: string;
  /** Frame interval in milliseconds. */
  intervalMs?: number;
}

/**
 * A tiny animated spinner. Frames come from the active {@link useIcons} theme,
 * so the `ascii` tier degrades to plain `|/-\` instead of leaking unicode on a
 * basic terminal.
 */
export function Spinner({ label, intervalMs = 80 }: SpinnerProps) {
  const { spinnerFrames } = useIcons();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [spinnerFrames.length, intervalMs]);

  const glyph = spinnerFrames[frame % spinnerFrames.length];
  return <Text>{label ? `${glyph} ${label}` : glyph}</Text>;
}
