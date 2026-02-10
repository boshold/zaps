/* eslint-disable eslint-plugin-promise/prefer-await-to-then -- Fire-and-forget in event handlers */
/* eslint-disable eslint-plugin-promise/catch-or-return -- Fire-and-forget promises with .finally() */
import { execFile } from "node:child_process";

import type { ResolvedConfig } from "../config/types.js";
import type { ServiceManager } from "../lib/service/manager.js";
import type { ServiceStatus } from "../lib/service/types.js";
import { useApp as useInkApp, useInput } from "ink";
import { useRef, useState } from "react";

import { useLogs } from "../hooks/useLogs.js";
import { useRouter } from "../hooks/useRouter.js";
import { useSelection } from "../hooks/useSelection.js";
import { useServiceActions } from "../hooks/useServiceActions.js";
import { useServices } from "../hooks/useServices.js";
import { AppProvider, useZaps } from "../hooks/useZaps.js";

import { Dashboard } from "./Dashboard.js";
import { LogView } from "./LogView.js";
import { TasksView } from "./TasksView.js";

type PaneMap = Record<string, string>;

interface AppProps {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
}

function openInBrowser(status: ServiceStatus) {
  if (!status.url) {
    return;
  }

  // HTTP HEAD to verify reachable (2s timeout)
  fetch(status.url, {
    method: "HEAD",
    signal: AbortSignal.timeout(2000),
  })
    .then(() => {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      execFile(cmd, [status.url!]);
      return null;
    })
    .catch(() => {
      // Not reachable — silently ignore
    });
}

function Router() {
  const { view, logTarget, goToLogs, goToDashboard, goToTasks } = useRouter();
  const { manager, paneMap } = useZaps();
  const statuses = useServices(manager);
  const { restart, toggle, restartAll } = useServiceActions(manager);

  // Selection count depends on view: services for dashboard, tasks for tasks view
  const { config } = useZaps();
  const taskEntries = Object.entries(config.project.tasks ?? {});
  const itemCount = view === "tasks" ? taskEntries.length : statuses.length;
  const { index, moveUp, moveDown } = useSelection(itemCount);

  const { exit } = useInkApp();
  const busyRef = useRef(false);

  // Logs state — called unconditionally (hooks rule)
  const logPaneTarget = logTarget ? (paneMap[logTarget] ?? null) : null;
  const {
    lines: logLines,
    autoScroll: logAutoScroll,
    offset: logOffset,
    scrollUp,
    scrollDown,
  } = useLogs(logPaneTarget);

  // Task run trigger — incremented on Enter in tasks view
  const [runTrigger, setRunTrigger] = useState(0);

  useInput((input, key) => {
    // Global keys
    if (input === "q") {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      manager
        .stopAll()
        .catch(() => {
          /* Graceful shutdown */
        })
        .finally(() => {
          exit();
        });
      return;
    }

    if (view === "dashboard") {
      if (key.upArrow) {
        moveUp();
      }
      if (key.downArrow) {
        moveDown();
      }
      if (input === "r" && statuses[index] && !busyRef.current) {
        busyRef.current = true;
        void restart(statuses[index].name).finally(() => {
          busyRef.current = false;
        });
      }
      if (input === "s" && statuses[index] && !busyRef.current) {
        busyRef.current = true;
        void toggle(statuses[index].name).finally(() => {
          busyRef.current = false;
        });
      }
      if (input === "l" && statuses[index]) {
        goToLogs(statuses[index].name);
      }
      if (input === "o" && statuses[index]) {
        openInBrowser(statuses[index]);
      }
      if (input === "t") {
        goToTasks();
      }
      if (input === "a" && !busyRef.current) {
        busyRef.current = true;
        void restartAll().finally(() => {
          busyRef.current = false;
        });
      }
    }

    if (view === "logs") {
      if (key.escape) {
        goToDashboard();
      }
      if (key.upArrow) {
        scrollUp();
      }
      if (key.downArrow) {
        scrollDown();
      }
    }

    if (view === "tasks") {
      if (key.escape) {
        goToDashboard();
      }
      if (key.upArrow) {
        moveUp();
      }
      if (key.downArrow) {
        moveDown();
      }
      if (key.return) {
        setRunTrigger((n) => n + 1);
      }
    }
  });

  // Conditional render — pass state as props
  if (view === "logs" && logTarget) {
    return (
      <LogView
        serviceName={logTarget}
        lines={logLines}
        autoScroll={logAutoScroll}
        offset={logOffset}
      />
    );
  }
  if (view === "tasks") {
    return <TasksView selectedIndex={index} runTrigger={runTrigger} />;
  }
  return <Dashboard statuses={statuses} selectedIndex={index} />;
}

export function App({ manager, config, paneMap }: AppProps) {
  return (
    <AppProvider manager={manager} config={config} paneMap={paneMap}>
      <Router />
    </AppProvider>
  );
}
