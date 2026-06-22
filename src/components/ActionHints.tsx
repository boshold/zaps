import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { serviceHints } from "./hintText.js";
import { useIcons } from "./theme/IconTheme.js";

/**
 * Truncate to a column budget with a trailing ellipsis. Uses the icon-tier
 * ellipsis (`…` / `...`) rather than Ink's `wrap="truncate-end"`, whose hardcoded
 * `…` would break the ascii 7-bit invariant. Bracket hint strings are ascii, so
 * string length is an accurate column width here.
 */
function truncate(text: string, max: number, ellipsis: string): string {
  if (max <= 0) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  if (max <= ellipsis.length) {
    return text.slice(0, max);
  }
  return text.slice(0, max - ellipsis.length) + ellipsis;
}

interface ActionHintsProps {
  status?: ServiceStatus;
  /** Column budget for the left cell; the hints truncate with an ellipsis past it. */
  maxWidth?: number;
}

/**
 * Left footer cell: the service-specific hints, clamped to `maxWidth` and
 * truncated with an ellipsis on overflow so the global hints on the right stay
 * intact and right-aligned.
 */
export function ActionHints({ status, maxWidth }: ActionHintsProps) {
  const { icon } = useIcons();
  const hints = serviceHints(status);
  const text = maxWidth === undefined ? hints : truncate(hints, maxWidth, icon("ellipsis"));
  return (
    <Box width={maxWidth} marginRight={2}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
