/* eslint-disable eslint-plugin-promise/prefer-await-to-then -- Fire-and-forget in event handlers */
/* eslint-disable eslint-plugin-promise/catch-or-return -- Fire-and-forget promises with .finally() */
import { useLogs } from "#src/hooks/useLogs.js";
import { useRouter } from "#src/hooks/useRouter.js";
import { useSelection } from "#src/hooks/useSelection.js";
import { useServiceActions } from "#src/hooks/useServiceActions.js";
import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { openInBrowser } from "#src/lib/open.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { getTaskShortcuts } from "#src/lib/taskShortcuts.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import type { Key } from "ink";
import { useApp as useInkApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { Dashboard } from "./Dashboard.js";
import { LogView } from "./LogView.js";
import { TasksView } from "./TasksView.js";

const MAX_HISTORY = 50;

function handleDashboardInput(
  input: string,
  key: Key,
  ctx: {
    statuses: ServiceStatus[];
    index: number;
    busyRef: React.RefObject<boolean>;
    moveUp: () => void;
    moveDown: () => void;
    restart: (name: string) => Promise<void>;
    toggle: (name: string) => Promise<void>;
    restartAll: () => Promise<void>;
    goToLogs: (name: string) => void;
    goToTasks: () => void;
  },
) {
  if (key.upArrow || input === "k") {
    ctx.moveUp();
  }
  if (key.downArrow || input === "j") {
    ctx.moveDown();
  }
  if (input === "r" && ctx.statuses[ctx.index] && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    // eslint-disable-next-line no-void -- Fire-and-forget promise
    void ctx.restart(ctx.statuses[ctx.index].name).finally(() => {
      ctx.busyRef.current = false;
    });
  }
  if (input === "s" && ctx.statuses[ctx.index] && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    // eslint-disable-next-line no-void -- Fire-and-forget promise
    void ctx.toggle(ctx.statuses[ctx.index].name).finally(() => {
      ctx.busyRef.current = false;
    });
  }
  if (input === "l" && ctx.statuses[ctx.index]) {
    ctx.goToLogs(ctx.statuses[ctx.index].name);
  }
  const selectedUrl = ctx.statuses[ctx.index]?.url;
  if (input === "o" && selectedUrl) {
    // eslint-disable-next-line no-void -- Fire-and-forget browser open
    void openInBrowser(selectedUrl);
  }
  if (input === "t") {
    ctx.goToTasks();
  }
  if (input === "a" && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    // eslint-disable-next-line no-void -- Fire-and-forget promise
    void ctx.restartAll().finally(() => {
      ctx.busyRef.current = false;
    });
  }
}

function handleLogsInput(
  input: string,
  key: Key,
  ctx: { goToDashboard: () => void; scrollUp: () => void; scrollDown: () => void },
) {
  if (key.escape) {
    ctx.goToDashboard();
  }
  if (key.upArrow || input === "k") {
    ctx.scrollUp();
  }
  if (key.downArrow || input === "j") {
    ctx.scrollDown();
  }
}

function handleTasksInput(
  input: string,
  key: Key,
  ctx: {
    taskShortcuts: { shortcut: string; name: string }[];
    taskEntries: [string, { name: string }][];
    setIndex: (i: number) => void;
    goToDashboard: () => void;
    moveUp: () => void;
    moveDown: () => void;
    setRunTrigger: React.Dispatch<React.SetStateAction<number>>;
  },
) {
  if (key.escape) {
    ctx.goToDashboard();
  }
  if (key.upArrow || input === "k") {
    ctx.moveUp();
    return;
  }
  if (key.downArrow || input === "j") {
    ctx.moveDown();
    return;
  }
  if (key.return) {
    ctx.setRunTrigger((n) => n + 1);
  }

  // Match input against task shortcuts
  const matched = ctx.taskShortcuts.find((t) => t.shortcut === input);
  if (matched) {
    const idx = ctx.taskEntries.findIndex(([, task]) => task.name === matched.name);
    if (idx !== -1) {
      ctx.setIndex(idx);
      ctx.setRunTrigger((n) => n + 1);
    }
  }
}

export function Router() {
  const { view, logTarget, goToLogs, goToDashboard, goToTasks } = useRouter();
  const { manager, paneMap, config } = useZaps();
  const statuses = useServices(manager);
  const { restart, toggle, restartAll } = useServiceActions(manager);

  // Selection count depends on view: services for dashboard, tasks for tasks view
  const taskEntries = Object.entries(config.project.tasks ?? {});
  const itemCount = view === "tasks" ? taskEntries.length : statuses.length;
  const { index, setIndex, moveUp, moveDown } = useSelection(itemCount);

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

  // Task run history — shared between Dashboard and TasksView
  const [taskHistory, setTaskHistory] = useState<TaskRunRecord[]>([]);

  function onTaskComplete(record: TaskRunRecord) {
    setTaskHistory((prev) => [record, ...prev].slice(0, MAX_HISTORY));
  }

  // Subscribe to hook-triggered task completions from ServiceManager
  useEffect(() => {
    function handleTaskComplete(taskKey: string, taskName: string, result: "success" | "error") {
      onTaskComplete({ taskKey, taskName, result, timestamp: Date.now() });
    }
    manager.on("taskComplete", handleTaskComplete);
    return () => {
      manager.off("taskComplete", handleTaskComplete);
    };
  }, [manager]);

  // Precompute task shortcuts
  const taskShortcuts = getTaskShortcuts(config.project.tasks ?? {});

  useInput((input, key) => {
    // Q: quit on dashboard, go back on sub-views
    if (input === "q") {
      if (view === "dashboard") {
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
      } else {
        goToDashboard();
      }
      return;
    }

    if (view === "dashboard") {
      handleDashboardInput(input, key, {
        statuses,
        index,
        busyRef,
        moveUp,
        moveDown,
        restart,
        toggle,
        restartAll,
        goToLogs,
        goToTasks,
      });
    }

    if (view === "logs") {
      handleLogsInput(input, key, { goToDashboard, scrollUp, scrollDown });
    }

    if (view === "tasks") {
      handleTasksInput(input, key, {
        taskShortcuts,
        taskEntries,
        setIndex,
        goToDashboard,
        moveUp,
        moveDown,
        setRunTrigger,
      });
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
    return (
      <TasksView
        selectedIndex={index}
        runTrigger={runTrigger}
        taskShortcuts={taskShortcuts}
        taskHistory={taskHistory}
        onTaskComplete={onTaskComplete}
      />
    );
  }
  return <Dashboard statuses={statuses} selectedIndex={index} taskHistory={taskHistory} />;
}
