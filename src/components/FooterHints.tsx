import { Box } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { ActionHints } from "./ActionHints.js";
import { HelpBar } from "./HelpBar.js";
import { GLOBAL_HINTS } from "./hintText.js";

/** Gap between the left (service) hints and the right (global) hints. */
const GAP = 2;

interface FooterHintsProps {
  compact?: boolean;
  status?: ServiceStatus;
  /** Footer width, used to budget the left cell so the global hints stay intact. */
  width: number;
}

/**
 * The footer's single hint line: service-specific hints on the left (clamped and
 * ellipsised on overflow) and global hints on the right. The left budget is the
 * width minus the global hints and a gap, so the global hints are never
 * truncated and sit flush right. Compact mode keeps the existing one-line merged
 * HelpBar untouched. Children stay one level deep so the JSX nesting never trips
 * oxlint's `jsx-max-depth`.
 */
export function FooterHints({ compact, status, width }: FooterHintsProps) {
  if (compact) {
    return <HelpBar compact status={status} />;
  }
  const leftBudget = Math.max(0, width - GLOBAL_HINTS.length - GAP);
  return (
    <Box flexDirection="row">
      <ActionHints status={status} maxWidth={leftBudget} />
      <HelpBar status={status} />
    </Box>
  );
}
