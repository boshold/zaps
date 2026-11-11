import type { Key } from "ink";
import { useInput } from "ink";

import type { ProjectedServiceStatus } from "#src/daemon/session.js";
import { canZoomDashboard, serviceAvailability } from "#src/lib/backend/capabilities.js";
import type { BackendCapabilities } from "#src/lib/backend/types.js";
import { openInBrowser } from "#src/lib/open.js";

import type { BusyServices } from "./busyServices.js";

/** Everything the dashboard key handler needs, owned by the Router and passed down. */
interface DashboardInputContext {
  statuses: ProjectedServiceStatus[];
  capabilities: BackendCapabilities;
  index: number;
  busyServices: Pick<BusyServices, "getSnapshot">;
  moveUp: () => void;
  moveDown: () => void;
  restart: (name: string) => void;
  toggle: (name: string) => void;
  restartAll: () => void;
  reloadConfig: () => void;
  goToLogs: (name: string) => void;
  openTaskPicker: () => void;
  goToDockerRebuild: (name: string) => void;
  destroySession: () => void;
  zoomService: (name: string) => void;
  zoomDashboard: () => void;
  editCaptureService: (name: string) => void;
}

// eslint-disable-next-line complexity -- Flat key-dispatch handler, inherently branchy
function handleDashboardInput(input: string, key: Key, ctx: DashboardInputContext) {
  if (key.ctrl || key.meta) {
    return;
  }
  if (key.upArrow || input === "k") {
    ctx.moveUp();
  }
  if (key.downArrow || input === "j") {
    ctx.moveDown();
  }
  const selected = ctx.statuses[ctx.index];
  const selectedName = selected?.name;
  const availability = serviceAvailability(
    ctx.capabilities,
    selected,
    selectedName !== undefined && ctx.busyServices.getSnapshot().has(selectedName),
  );

  if (input === "r" && selected && availability.control) {
    ctx.restart(selectedName);
  }
  if (input === "s" && selected && availability.control) {
    ctx.toggle(selectedName);
  }
  if (input === "l" && selected && availability.logs) {
    ctx.goToLogs(selectedName);
  }
  const selectedUrl = selected?.url;
  if (input === "o" && selectedUrl) {
    void openInBrowser(selectedUrl).catch(() => undefined);
  }
  if (input === "R" && selected && availability.rebuild) {
    ctx.goToDockerRebuild(selectedName);
  }
  if (input === "z" && selected && availability.zoom) {
    ctx.zoomService(selectedName);
  }
  if (input === "Z" && canZoomDashboard(ctx.capabilities)) {
    ctx.zoomDashboard();
  }
  if (input === "E" && selected && availability.editOutput) {
    ctx.editCaptureService(selectedName);
  }
  if (input === "d") {
    ctx.destroySession();
    return;
  }
  if (input === "t") {
    ctx.openTaskPicker();
  }
  if (input === "a") {
    ctx.restartAll();
  }
  if (input === "c") {
    ctx.reloadConfig();
  }
}

/**
 * The dashboard's own input owner. Active only when the Router routes input to
 * the dashboard (`isActive`); inert otherwise, so no key is double-handled.
 */
function useDashboardInput(ctx: DashboardInputContext | undefined, isActive: boolean): void {
  useInput(
    (input, key) => {
      if (ctx) {
        handleDashboardInput(input, key, ctx);
      }
    },
    { isActive },
  );
}

export { useDashboardInput };
export type { DashboardInputContext };
