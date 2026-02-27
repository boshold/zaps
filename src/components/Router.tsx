import type { DockerConfig } from "#src/config/types.js";
import { useLogs } from "#src/hooks/useLogs.js";
import { useRouter } from "#src/hooks/useRouter.js";
import { useSelection } from "#src/hooks/useSelection.js";
import { useServiceActions } from "#src/hooks/useServiceActions.js";
import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { openInBrowser } from "#src/lib/open.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { editPaneCapture, zoomPane } from "#src/lib/tmux.js";
import type { Key } from "ink";
import { useApp as useInkApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { Dashboard } from "./Dashboard.js";
import type { DockerFlagKey } from "./DockerRebuildView.js";
import { DOCKER_REBUILD_FLAGS, DockerRebuildPopup } from "./DockerRebuildView.js";
import { LogView } from "./LogView.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { TasksView } from "./TasksView.js";

const MAX_HISTORY = 50;

// eslint-disable-next-line complexity -- Flat key-dispatch handler, inherently branchy
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
    goToDockerRebuild: (name: string) => void;
    destroySession: () => void;
    paneMap: Record<string, string>;
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
    void ctx
      .restart(ctx.statuses[ctx.index].name)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyRef.current = false;
      });
  }
  if (input === "s" && ctx.statuses[ctx.index] && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    void ctx
      .toggle(ctx.statuses[ctx.index].name)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyRef.current = false;
      });
  }
  if (input === "l" && ctx.statuses[ctx.index]) {
    ctx.goToLogs(ctx.statuses[ctx.index].name);
  }
  const selectedUrl = ctx.statuses[ctx.index]?.url;
  if (input === "o" && selectedUrl) {
    void openInBrowser(selectedUrl);
  }
  if (input === "R" && ctx.statuses[ctx.index]?.isDocker) {
    ctx.goToDockerRebuild(ctx.statuses[ctx.index].name);
  }
  if (input === "z" && ctx.statuses[ctx.index]) {
    const paneId = ctx.paneMap[ctx.statuses[ctx.index].name];
    if (paneId) {
      void zoomPane(paneId);
    }
  }
  if (input === "E" && ctx.statuses[ctx.index] && !ctx.busyRef.current) {
    const paneId = ctx.paneMap[ctx.statuses[ctx.index].name];
    if (paneId) {
      ctx.busyRef.current = true;
      void editPaneCapture(paneId, ctx.statuses[ctx.index].name)
        .catch(() => {
          /* IPC error — ignore */
        })
        .finally(() => {
          ctx.busyRef.current = false;
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
  if (input === "a" && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    void ctx
      .restartAll()
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
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
    tasks: { key: string; name: string }[];
    taskShortcuts: { shortcut: string; name: string }[];
    taskCount: number;
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
    const idx = ctx.tasks.findIndex((t) => t.name === matched.name);
    if (idx !== -1) {
      ctx.setIndex(idx);
      ctx.setRunTrigger((n) => n + 1);
    }
  }
}

function buildDockerOverrides(flags: Record<DockerFlagKey, boolean>): Partial<DockerConfig> {
  const overrides: Partial<DockerConfig> = {};
  if (flags.build) {
    overrides.build = true;
  }
  if (flags.forceRecreate) {
    overrides.forceRecreate = true;
  }
  if (flags.renewVolumes) {
    overrides.renewVolumes = true;
  }
  if (flags.pull) {
    overrides.pull = "always";
  }
  if (flags.removeOrphans) {
    overrides.removeOrphans = true;
  }
  return overrides;
}

function handleDockerRebuildInput(
  input: string,
  key: Key,
  ctx: {
    flagIndex: number;
    setFlagIndex: React.Dispatch<React.SetStateAction<number>>;
    dockerFlags: Record<DockerFlagKey, boolean>;
    setDockerFlags: React.Dispatch<React.SetStateAction<Record<DockerFlagKey, boolean>>>;
    dockerRebuildTarget: string;
    busyRef: React.RefObject<boolean>;
    rebuildDocker: (name: string, overrides: Partial<DockerConfig>) => Promise<void>;
    goToDashboard: () => void;
  },
) {
  if (key.escape) {
    ctx.goToDashboard();
    return;
  }
  if (key.upArrow || input === "k") {
    ctx.setFlagIndex((i) => Math.max(0, i - 1));
    return;
  }
  if (key.downArrow || input === "j") {
    ctx.setFlagIndex((i) => Math.min(DOCKER_REBUILD_FLAGS.length - 1, i + 1));
    return;
  }
  if (input === " ") {
    const flagKey = DOCKER_REBUILD_FLAGS[ctx.flagIndex].key;
    ctx.setDockerFlags((prev) => ({ ...prev, [flagKey]: !prev[flagKey] }));
    return;
  }
  if (key.return && !ctx.busyRef.current) {
    ctx.busyRef.current = true;
    const overrides = buildDockerOverrides(ctx.dockerFlags);
    ctx.goToDashboard();
    void ctx
      .rebuildDocker(ctx.dockerRebuildTarget, overrides)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        ctx.busyRef.current = false;
      });
  }
}

export function Router({
  initialStatuses,
  initialTaskHistory,
  autoStart,
}: {
  initialStatuses: ServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}) {
  const {
    view,
    logTarget,
    dockerRebuildTarget,
    goToLogs,
    goToDashboard,
    goToTasks,
    goToDockerRebuild,
  } = useRouter();
  const { client, paneMap, tasks, servicesMeta } = useZaps();
  const statuses = useServices(client, initialStatuses);
  const { restart, toggle, restartAll, rebuildDocker } = useServiceActions(client);

  // Selection count depends on view: services for dashboard, tasks for tasks view
  const itemCount = view === "tasks" ? tasks.length : statuses.length;
  const { index, setIndex, moveUp, moveDown } = useSelection(itemCount);

  const { exit } = useInkApp();
  const busyRef = useRef(false);

  // Logs state — now uses daemon client event stream
  const {
    lines: logLines,
    autoScroll: logAutoScroll,
    offset: logOffset,
    scrollUp,
    scrollDown,
  } = useLogs(client, logTarget);

  // Docker rebuild popup state
  const defaultFlags: Record<DockerFlagKey, boolean> = {
    build: false,
    forceRecreate: false,
    renewVolumes: false,
    pull: false,
    removeOrphans: false,
  };
  const [dockerFlags, setDockerFlags] = useState(defaultFlags);
  const [dockerFlagIndex, setDockerFlagIndex] = useState(0);

  // Task run trigger — incremented on Enter in tasks view
  const [runTrigger, setRunTrigger] = useState(0);

  // Task run history — shared between Dashboard and TasksView
  const [taskHistory, setTaskHistory] = useState<TaskRunRecord[]>(initialTaskHistory);

  function onTaskComplete(record: TaskRunRecord) {
    setTaskHistory((prev) => {
      if (record.result === "running") {
        return [record, ...prev].slice(0, MAX_HISTORY);
      }
      // Replace matching running entry, or prepend if not found
      const runningIdx = prev.findIndex(
        (r) => r.taskKey === record.taskKey && r.result === "running",
      );
      if (runningIdx !== -1) {
        const next = [...prev];
        next[runningIdx] = record;
        return next;
      }
      return [record, ...prev].slice(0, MAX_HISTORY);
    });
  }

  // Subscribe to daemon task events
  useEffect(() => {
    function handleTaskStart(taskKey: string, taskName: string) {
      onTaskComplete({ taskKey, taskName, result: "running", timestamp: Date.now() });
    }
    function handleTaskComplete(taskKey: string, taskName: string, result: "success" | "error") {
      onTaskComplete({ taskKey, taskName, result, timestamp: Date.now() });
    }
    client.on("task.start", handleTaskStart);
    client.on("task.complete", handleTaskComplete);
    return () => {
      client.off("task.start", handleTaskStart);
      client.off("task.complete", handleTaskComplete);
    };
  }, [client]);

  // Ready gate: delay rendering until minimum splash time
  const [ready, setReady] = useState(!autoStart);

  useEffect(() => {
    if (!autoStart) {
      return;
    }

    const MIN_SPLASH_MS = 1200;
    let activityDetected = false;
    let timerElapsed = false;

    // Check if services are already starting/ready (daemon started them before TUI connected)
    const alreadyActive = statuses.some((s) => s.state !== "stopped");
    if (alreadyActive) {
      activityDetected = true;
    }

    function tryReady() {
      if (activityDetected && timerElapsed) {
        setReady(true);
      }
    }

    function onFirstAction() {
      activityDetected = true;
      client.off("service.stateChange", onFirstAction);
      client.off("task.start", onFirstAction);
      tryReady();
    }

    if (!activityDetected) {
      client.on("service.stateChange", onFirstAction);
      client.on("task.start", onFirstAction);
    }

    const timer = setTimeout(() => {
      timerElapsed = true;
      tryReady();
    }, MIN_SPLASH_MS);

    return () => {
      client.off("service.stateChange", onFirstAction);
      client.off("task.start", onFirstAction);
      clearTimeout(timer);
    };
  }, [autoStart, client]); // eslint-disable-line react-hooks/exhaustive-deps -- statuses read once on mount

  // Build service metadata lookup
  const svcMetaMap = new Map(servicesMeta.map((m) => [m.name, m]));

  // Precompute task shortcuts from snapshot data
  const taskShortcuts = tasks.flatMap((t) =>
    t.shortcut ? [{ shortcut: t.shortcut, name: t.name }] : [],
  );

  useInput((input, key) => {
    // Q / ctrl+c: detach from any view (services keep running)
    if (input === "q" || (key.ctrl && input === "c")) {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      client.disconnect();
      exit();
      return;
    }

    // Ctrl+d: shut down — destroy session from any view
    if (key.ctrl && input === "d") {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      client
        .destroySession()
        .catch(() => {
          /* Graceful shutdown */
        })
        .finally(() => {
          client.disconnect();
          exit();
        });
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
        destroySession: () => {
          if (busyRef.current) {
            return;
          }
          busyRef.current = true;
          client
            .destroySession()
            .catch(() => {
              /* Graceful shutdown */
            })
            .finally(() => {
              client.disconnect();
              exit();
            });
        },
        paneMap,
        goToDockerRebuild: (name: string) => {
          const meta = svcMetaMap.get(name);
          setDockerFlags({
            build: meta?.dockerDefaults.build ?? false,
            forceRecreate: meta?.dockerDefaults.forceRecreate ?? false,
            renewVolumes: meta?.dockerDefaults.renewVolumes ?? false,
            pull: meta?.dockerDefaults.pull ?? false,
            removeOrphans: meta?.dockerDefaults.removeOrphans ?? false,
          });
          setDockerFlagIndex(0);
          goToDockerRebuild(name);
        },
      });
    }

    if (view === "logs") {
      handleLogsInput(input, key, { goToDashboard, scrollUp, scrollDown });
    }

    if (view === "tasks") {
      handleTasksInput(input, key, {
        tasks,
        taskShortcuts,
        taskCount: tasks.length,
        setIndex,
        goToDashboard,
        moveUp,
        moveDown,
        setRunTrigger,
      });
    }

    if (view === "dockerRebuild" && dockerRebuildTarget) {
      handleDockerRebuildInput(input, key, {
        flagIndex: dockerFlagIndex,
        setFlagIndex: setDockerFlagIndex,
        dockerFlags,
        setDockerFlags,
        dockerRebuildTarget,
        busyRef,
        rebuildDocker,
        goToDashboard,
      });
    }
  });

  if (!ready) {
    return null;
  }

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
      />
    );
  }
  return (
    <>
      <Dashboard statuses={statuses} selectedIndex={index} taskHistory={taskHistory} />
      {view === "dockerRebuild" && dockerRebuildTarget && (
        <DockerRebuildPopup
          serviceName={dockerRebuildTarget}
          flags={dockerFlags}
          flagIndex={dockerFlagIndex}
        />
      )}
    </>
  );
}
