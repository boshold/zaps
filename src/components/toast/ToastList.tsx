import { Box, Text } from "ink";

import type { IconKey } from "#src/components/theme/icons.js";
import { useIcons } from "#src/components/theme/IconTheme.js";
import type { Toast, ToastLevel } from "#src/hooks/useToasts.js";

/** Per-level foreground color. Color is never the sole signal — glyphs differ too. */
const LEVEL_COLOR: Record<ToastLevel, string> = {
  info: "cyan",
  success: "green",
  error: "red",
};

function levelGlyph(level: ToastLevel, icon: (key: IconKey) => string): string {
  if (level === "success") {
    return icon("taskSuccess");
  }
  if (level === "error") {
    return icon("taskError");
  }
  return icon("dot");
}

interface ToastListProps {
  /** Already sliced to the visible window by the host (most-recent last). */
  toasts: Toast[];
  /** Total sticky-failure count, for the persistent acknowledge badge. */
  stickyTotal: number;
  width?: number;
}

/**
 * The absolute-free toast body (rendered inside {@link ToastHost}'s float). One
 * line per visible toast plus a persistent badge while any sticky failure is
 * outstanding, reminding the user of the dismiss key. Kept positioning-free so
 * it stays render-testable (ink-testing-library cannot capture absolute boxes).
 */
export function ToastList({ toasts, stickyTotal, width }: ToastListProps) {
  const { icon } = useIcons();

  return (
    <Box flexDirection="column" width={width}>
      {toasts.map((toast) => (
        <Text key={toast.id} color={LEVEL_COLOR[toast.level]} wrap="truncate-end">
          {levelGlyph(toast.level, icon)} {toast.message}
        </Text>
      ))}
      {stickyTotal > 0 && (
        <Text color="red" bold wrap="truncate-end">
          {icon("taskError")} {stickyTotal} failure{stickyTotal === 1 ? "" : "s"} — press x to
          dismiss
        </Text>
      )}
    </Box>
  );
}
