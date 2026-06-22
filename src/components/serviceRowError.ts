import type { ServiceStatus } from "#src/lib/service/types.js";

/**
 * Whether a row shows its `lastError` sub-row. The selected row always shows it;
 * failed/stopped services with a `lastError` show it unconditionally so a dependent
 * of a failed dependency surfaces `Dependency "X" not ready` instead of a bare
 * "stopped" without selection (C4). Lives in its own module so both ServiceRow
 * (rendering) and ServiceList (row-height accounting) can share it without a
 * component file exporting a non-component helper.
 */
export function showsErrorSubRow(status: ServiceStatus, isSelected: boolean): boolean {
  return (
    Boolean(status.lastError) &&
    (isSelected || status.state === "error" || status.state === "stopped")
  );
}

/**
 * Whether the inline error sub-row renders in the list. When the right-hand
 * detail pane is visible (`detailVisible`, wide layout) the selected service's
 * full error lives there instead, so the list stays uncluttered — only the
 * per-row alert glyph signals trouble. Narrow layouts (no detail pane) keep the
 * inline sub-row so the error text remains reachable.
 */
export function showsInlineError(
  status: ServiceStatus,
  isSelected: boolean,
  detailVisible: boolean,
): boolean {
  return !detailVisible && showsErrorSubRow(status, isSelected);
}
