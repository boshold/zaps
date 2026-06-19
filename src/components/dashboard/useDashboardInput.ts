import type { Key } from "ink";
import { useInput } from "ink";

import { openInBrowser } from "#src/lib/open.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { editPaneCapture, zoomPane } from "#src/lib/tmux.js";

/** Everything the dashboard key handler needs, owned by the Router and passed down. */
interface DashboardInputContext {
  statuses: ServiceStatus[];
  index: number;
  busyServices: React.RefObject<Set<string>>;
  moveUp: () => void;
  moveDown: () => void;
  restart: (name: string) => Promise<void>;
  toggle: (name: string) => Promise<void>;
  restartAll: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  goToLogs: (name: string) => void;
  goToTasks: () => void;
  goToDockerRebuild: (name: string) => void;
  destroySession: () => void;
  paneMap: Record<string, string>;
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
  const isBusy = selectedName ? ctx.busyServices.current.has(selectedName) : true;
  const isUnavailable = selected?.state === "unavailable";

  if (input === "r" && selected && !isBusy && !isUnavailable) {
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
  if (input === "s" && selected && !isBusy && !isUnavailable) {
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
  if (input === "l" && selected && !isUnavailable) {
    ctx.goToLogs(selectedName);
  }
  const selectedUrl = selected?.url;
  if (input === "o" && selectedUrl) {
    void openInBrowser(selectedUrl);
  }
  if (input === "R" && selected?.isDocker && !isUnavailable) {
    ctx.goToDockerRebuild(selectedName);
  }
  // Detached services have no pane, so zoom/edit-capture are disabled (E4).
  if (input === "z" && selected && !isUnavailable && !selected.isDetached) {
    const paneId = ctx.paneMap[selectedName];
    if (paneId) {
      void zoomPane(paneId);
    }
  }
  if (input === "Z") {
    const tuiPaneId = ctx.paneMap["@tui"];
    if (tuiPaneId) {
      void zoomPane(tuiPaneId);
    }
  }
  if (input === "E" && selected && !isBusy && !isUnavailable && !selected.isDetached) {
    const paneId = ctx.paneMap[selectedName];
    if (paneId) {
      ctx.busyServices.current.add(selectedName);
      void editPaneCapture(paneId, selectedName)
        .catch(() => {
          /* IPC error — ignore */
        })
        .finally(() => {
          ctx.busyServices.current.delete(selectedName);
        });
    }
  }
  if (input === "d") {
    ctx.destroySession();
    return;
  }
  if (input === "t") {
    ctx.goToTasks();
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
