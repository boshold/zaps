import { Box } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useToasts } from "#src/hooks/useToasts.js";

import { ToastList } from "./ToastList.js";

/** How many recent toasts to show at once (older ones scroll off the top). */
const MAX_VISIBLE = 3;
// Rows kept clear below the float so it floats *above* the footer's help/hint
// Lines rather than over them. The float is out of layout flow (absolute), so
// This is a placement offset only — it can never shrink or blank the body
// (unlike the v1 chromeRows budget).
const FOOTER_RESERVE = 2;

/**
 * Floating bottom-anchored toast slot. Rendered as a sibling of the base view in
 * `AppShell` and positioned with `position="absolute"` (like the command palette)
 * so it overlays without participating in the measured layout. The visible toast
 * content lives in {@link ToastList}; this wrapper only does placement.
 */
export function ToastHost() {
  const { toasts } = useToasts();
  const { rows, cols } = useDimensions();

  if (toasts.length === 0) {
    return null;
  }

  const visible = toasts.slice(-MAX_VISIBLE);
  const stickyTotal = toasts.filter((toast) => toast.sticky).length;
  const lineCount = visible.length + (stickyTotal > 0 ? 1 : 0);
  const marginTop = Math.max(0, rows - lineCount - FOOTER_RESERVE);
  const width = Math.max(20, Math.min(cols - 2, 80));

  return (
    <Box position="absolute" marginTop={marginTop} marginLeft={1} width={width}>
      <ToastList toasts={visible} stickyTotal={stickyTotal} width={width} />
    </Box>
  );
}
