import type { ProjectedServiceStatus } from "#src/daemon/session.js";
import {
  canLaunchTask,
  canZoomDashboard,
  serviceAvailability,
} from "#src/lib/backend/capabilities.js";
import type { BackendCapabilities, ServiceActions } from "#src/lib/backend/types.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

/** Global (non-service-specific) hints, also used to budget the merged footer line. */
export const GLOBAL_HINTS = "[t]asks [a]ll restart [q]uit/detach [d]own";

/**
 * The service-specific (left-hand) hint string for the footer: the keymap for
 * the selected service, an availability note for unavailable services, or empty
 * when nothing is selected. Pure so {@link FooterHints} can place it beside the
 * global hints on one line.
 */
export function serviceHints(
  status: (ServiceStatus & { actions?: ServiceActions }) | undefined,
  capabilities: BackendCapabilities,
  busy = false,
): string {
  const availability = serviceAvailability(capabilities, status, busy);
  return [
    status?.state === "unavailable" && "Service not available on this system",
    availability.control && "[r]estart [s]top",
    availability.logs && "[l]ogs",
    availability.zoom && "[z]oom",
    canZoomDashboard(capabilities) && "[Z]aps zoom",
    availability.editOutput && "[E]dit",
    availability.logs && "[c]onfig",
    status?.url && "[o]pen",
    availability.rebuild && "[R]ebuild",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface KeymapGroup {
  title: string;
  /** `[keys, description]` rows — the documented keymap from `50_api.md`. */
  rows: [string, string][];
}

// Single in-app source for the keymap reference (mirrors 50_api.md "Command API").
export function helpKeymap(
  capabilities: BackendCapabilities,
  status: ProjectedServiceStatus | undefined,
  busy = false,
): KeymapGroup[] {
  const availability = serviceAvailability(capabilities, status, busy);
  const dashboard: KeymapGroup["rows"] = [
    ["↑↓ / k j", "Move selection"],
    ["a", "Restart all"],
    ["c", "Reload config"],
    ["t", "Task picker"],
  ];
  if (availability.control) {
    dashboard.push(["r", "Restart selected"], ["s", "Start/stop selected"]);
  }
  if (availability.logs) {
    dashboard.push(["l", "Open logs"]);
  }
  if (status?.url) {
    dashboard.push(["o", "Open URL"]);
  }
  if (availability.rebuild) {
    dashboard.push(["R", "Docker rebuild"]);
  }
  if (availability.zoom) {
    dashboard.push(["z", "Zoom service pane"]);
  }
  if (canZoomDashboard(capabilities)) {
    dashboard.push(["Z", "Zoom dashboard pane"]);
  }
  if (availability.editOutput) {
    dashboard.push(["E", "Edit-capture pane"]);
  }
  const picker: KeymapGroup["rows"] = [
    ["type", "Fuzzy filter"],
    ["↑↓", "Move"],
    ["Enter", "Run / confirm"],
    ["Esc", "Close"],
  ];
  if (canLaunchTask("pane", capabilities)) {
    picker.push(["Tab", "Run task in pane"]);
  }
  return [
    {
      title: "Global",
      rows: [
        ["Ctrl-K / :", "Command palette"],
        ["?", "Help (this)"],
        ["q / Ctrl-C", "Detach (services keep running)"],
        ["Ctrl-D", "Shut down session (confirm with y)"],
        ["Esc", "Close overlay / leave view"],
      ],
    },
    {
      title: "Dashboard",
      rows: dashboard,
    },
    {
      title: "Palette / picker",
      rows: picker,
    },
  ];
}
