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
