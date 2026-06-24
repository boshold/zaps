import type { ServiceStatus } from "#src/lib/service/types.js";

/** Global (non-service-specific) hints, also used to budget the merged footer line. */
export const GLOBAL_HINTS = "[t]asks [a]ll restart [q]uit/detach [d]own";

/**
 * The service-specific (left-hand) hint string for the footer: the keymap for
 * the selected service, an availability note for unavailable services, or empty
 * when nothing is selected. Pure so {@link FooterHints} can place it beside the
 * global hints on one line.
 */
export function serviceHints(status?: ServiceStatus): string {
  if (status?.state === "unavailable") {
    return "Service not available on this system";
  }
  if (!status) {
    return "";
  }
  return `[r]estart [s]top [l]ogs [z]oom [Z]aps zoom [E]dit [c]onfig${status.url ? " [o]pen" : ""}${status.isDocker ? " [R]ebuild" : ""}`;
}
