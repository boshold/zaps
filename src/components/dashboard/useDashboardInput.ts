import type { Key } from "ink";
import { useInput } from "ink";

import type { ProjectedServiceStatus } from "#src/daemon/session.js";
import { canZoomDashboard, serviceAvailability } from "#src/lib/backend/capabilities.js";
import type { BackendCapabilities } from "#src/lib/backend/types.js";
import { openInBrowser } from "#src/lib/open.js";

/** Everything the dashboard key handler needs, owned by the Router and passed down. */
interface DashboardInputContext {
  statuses: ProjectedServiceStatus[];
  capabilities: BackendCapabilities;
  index: number;
  busyServices: React.RefObject<Set<string>>;
  moveUp: () => void;
  moveDown: () => void;
  restart: (name: string) => Promise<void>;
  toggle: (name: string) => Promise<void>;
  restartAll: () => Promise<void>;
  reloadConfig: () => Promise<void>;
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
    selectedName !== undefined && ctx.busyServices.current.has(selectedName),
  );

  if (input === "r" && selected && availability.control) {
    ctx.busyServices.current.add(selectedName);
    void ctx
      .restart(selectedName)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyServices.current.delete(selectedName);
      });
  }
  if (input === "s" && selected && availability.control) {
    ctx.busyServices.current.add(selectedName);
    void ctx
      .toggle(selectedName)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyServices.current.delete(selectedName);
      });
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
  if (input === "a" && ctx.busyServices.current.size === 0) {
    for (const s of ctx.statuses) {
      ctx.busyServices.current.add(s.name);
    }
    void ctx
      .restartAll()
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyServices.current.clear();
      });
  }
  if (input === "c" && ctx.busyServices.current.size === 0) {
    for (const s of ctx.statuses) {
      ctx.busyServices.current.add(s.name);
    }
    void ctx
      .reloadConfig()
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyServices.current.clear();
      });
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
