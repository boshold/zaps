/**
 * Reusable empty/loading/disconnect copy so every "no data" branch reads the
 * same and the rewrite never renders a bare blank. Consumed by the dashboard
 * now and the task picker/palette in later phases.
 */
// Plain ascii base copy. Tier-specific punctuation (ellipsis, dash, dot) is
// Appended by the rendering components via the icon theme so the ascii tier
// Stays strictly 7-bit.
export const EMPTY_STATE_MESSAGES = {
  noServices: "No services configured. Add services to `.zaps.mts`.",
  loadingServices: "Starting services",
  noTasks: "No tasks defined in this config.",
  disconnected: "Daemon connection lost",
} as const;

/** Empty-filter placeholder for the picker/palette (Phase 4). */
export function emptyFilterMessage(query: string): string {
  return `No matches for '${query}'`;
}
