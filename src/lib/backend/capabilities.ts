import type { UiTaskMode } from "#src/config/types.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import type { BackendCapabilities, ServiceActions } from "./types.js";

export function canZoomDashboard(capabilities: BackendCapabilities): boolean {
  return capabilities.panes && capabilities.zoom;
}

export function canRebuildDocker(
  hasDocker: boolean | undefined,
  group: string | undefined,
): boolean {
  return hasDocker === true && group === undefined;
}

export function serviceAvailability(
  capabilities: BackendCapabilities,
  status: (ServiceStatus & { actions?: ServiceActions }) | undefined,
  busy = false,
) {
  const available = status !== undefined && status.state !== "unavailable";
  const canControl = available && !busy;
  const actions = status?.actions;
  return {
    control: canControl,
    logs: available,
    focus: available && capabilities.panes && actions?.focus === true,
    zoom: available && canZoomDashboard(capabilities) && actions?.zoom === true,
    editOutput:
      canControl && capabilities.panes && capabilities.popups && actions?.editOutput === true,
    rebuild: canControl && canRebuildDocker(status?.isDocker, status?.group),
  };
}

export function canLaunchTask(mode: UiTaskMode, capabilities: BackendCapabilities): boolean {
  return mode === "background" || capabilities.taskPanes;
}

export function effectiveTaskMode(mode: UiTaskMode, capabilities: BackendCapabilities): UiTaskMode {
  return canLaunchTask(mode, capabilities) ? mode : "background";
}
