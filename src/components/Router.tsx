import type { Key } from "ink";
import { useApp as useInkApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DockerConfig } from "#src/config/types.js";
import { useConnection } from "#src/hooks/useConnection.js";
import { useInputRouter } from "#src/hooks/useInputRouter.js";
import { useLogs } from "#src/hooks/useLogs.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import { useRouter } from "#src/hooks/useRouter.js";
import { useSelection } from "#src/hooks/useSelection.js";
import { useServiceActions } from "#src/hooks/useServiceActions.js";
import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { buildCommandRegistry } from "#src/lib/command-registry.js";
import { openInBrowser } from "#src/lib/open.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { editPaneCapture, zoomPane } from "#src/lib/tmux.js";

import { Dashboard } from "./Dashboard.js";
import type { DashboardInputContext } from "./dashboard/useDashboardInput.js";
import { DisconnectBanner } from "./DisconnectBanner.js";
import { LogView } from "./LogView.js";
import { COMMAND_PALETTE_ID, CommandPalette } from "./overlay/CommandPalette.js";
import type { DockerFlags } from "./overlay/DockerRebuildOverlay.js";
import { DOCKER_REBUILD_ID, DockerRebuildOverlay } from "./overlay/DockerRebuildOverlay.js";
import { HELP_OVERLAY_ID, HelpOverlay } from "./overlay/HelpOverlay.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { TasksView } from "./TasksView.js";

const MAX_HISTORY = 50;

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

export function Router({
  initialStatuses,
  initialTaskHistory,
  autoStart,
}: {
  initialStatuses: ServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}) {
  const { view, logTarget, goToLogs, goToDashboard, goToTasks } = useRouter();
  const { client, paneMap, tasks, servicesMeta } = useZaps();
  // First consumer of the daemon disconnect/connected surface. While offline the
  // Poll is gated (deliberate freeze of last-known state, not a silent catch).
  const { connected, retry } = useConnection(client);
  const statuses = useServices(client, initialStatuses, connected);
  const { restart, toggle, restartAll, rebuildDocker } = useServiceActions(client);

  // Sort once here (unavailable services to the bottom) and feed the SAME array to
  // Both rendering and the input handler so indexed actions always hit the
  // Highlighted row — the duplicate Dashboard-local sort is gone (F8).
  const sortedStatuses = useMemo(
    () => [
      ...statuses.filter((s) => s.state !== "unavailable"),
      ...statuses.filter((s) => s.state === "unavailable"),
    ],
    [statuses],
  );

  // Per-view selection: dashboard and tasks view each keep their own index,
  // Clamped only against their own list, so moving in one never shifts the other (F6).
  const dashboardSel = useSelection(sortedStatuses.length);
  const tasksSel = useSelection(tasks.length);

  const { exit } = useInkApp();
  const busyServices = useRef(new Set<string>());
  const globalBusyRef = useRef(false);

  // Logs state — now uses daemon client event stream
  const {
    lines: logLines,
    autoScroll: logAutoScroll,
    offset: logOffset,
    scrollUp,
    scrollDown,
  } = useLogs(client, logTarget);

  // Task run trigger — incremented on Enter in tasks view
  const [runTrigger, setRunTrigger] = useState(0);

  // Task run history — shared between Dashboard and TasksView
  const [taskHistory, setTaskHistory] = useState<TaskRunRecord[]>(initialTaskHistory);

  // Running-task state lives here (not in TasksView) so it survives leaving/re-entering the
  // Tasks view and blocks duplicate runs. Set optimistically on dispatch + by the task.start
  // Event; cleared only by the task.complete event, never by unmount (F4).
  const [runningTask, setRunningTask] = useState<string | null>(null);

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
      setRunningTask(taskKey);
    }
    function handleTaskComplete(taskKey: string, taskName: string, result: "success" | "error") {
      onTaskComplete({ taskKey, taskName, result, timestamp: Date.now() });
      setRunningTask((cur) => (cur === taskKey ? null : cur));
    }
    client.on("task.start", handleTaskStart);
    client.on("task.complete", handleTaskComplete);
    return () => {
      client.off("task.start", handleTaskStart);
      client.off("task.complete", handleTaskComplete);
    };
  }, [client]);

  // Ready gate: delay rendering for minimum splash time only
  const [ready, setReady] = useState(!autoStart);

  useEffect(() => {
    if (!autoStart) {
      return;
    }
    const timer = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(timer);
  }, [autoStart]);

  // Build service metadata lookup
  const svcMetaMap = new Map(servicesMeta.map((m) => [m.name, m]));

  // Precompute task shortcuts from snapshot data
  const taskShortcuts = tasks.flatMap((t) =>
    t.shortcut ? [{ shortcut: t.shortcut, name: t.name }] : [],
  );

  // Per-consumer input gating. Exactly one base view is active at a time; the top
  // Overlay owns input instead. Each view/overlay owns its own useInput.
  const overlay = useOverlay();
  const flags = useInputRouter(view, { ready, connected });

  // A lost daemon connection force-closes every overlay. The global keys
  // (q/Ctrl-C/r) yield to overlays, so a palette left open at the moment of
  // Disconnect would otherwise trap input; clearing the stack surfaces the
  // Sticky disconnect banner with the global keys live again.
  useEffect(() => {
    if (!connected && overlay.isOpen) {
      overlay.clear();
    }
  }, [connected, overlay]);

  // Tear down the session once, shared by Ctrl-D (global), `d` (dashboard), palette.
  function destroySession() {
    if (globalBusyRef.current) {
      return;
    }
    globalBusyRef.current = true;
    client
      .destroySession()
      .catch(() => {
        /* Graceful shutdown */
      })
      .finally(() => {
        client.disconnect();
        exit();
      });
  }

  // Detach (services keep running) — shared by `q`/Ctrl-C and the palette.
  function detachSession() {
    if (globalBusyRef.current) {
      return;
    }
    globalBusyRef.current = true;
    client.disconnect();
    exit();
  }

  // Run services.rebuild with the same per-service busy guard the quick keys use.
  // Shared by the docker overlay's Enter confirm.
  function confirmDockerRebuild(name: string, overrides: Partial<DockerConfig>) {
    if (busyServices.current.has(name)) {
      return;
    }
    busyServices.current.add(name);
    void rebuildDocker(name, overrides)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        busyServices.current.delete(name);
      });
  }

  // Open the docker-rebuild overlay with this service's defaults preloaded —
  // Shared by the dashboard `R` key and the palette's rebuild command.
  function openDockerRebuild(name: string) {
    const meta = svcMetaMap.get(name);
    const defaults: DockerFlags = {
      build: meta?.dockerDefaults.build ?? false,
      forceRecreate: meta?.dockerDefaults.forceRecreate ?? false,
      renewVolumes: meta?.dockerDefaults.renewVolumes ?? false,
      pull: meta?.dockerDefaults.pull ?? false,
      removeOrphans: meta?.dockerDefaults.removeOrphans ?? false,
    };
    overlay.push({
      id: DOCKER_REBUILD_ID,
      render: () => (
        <DockerRebuildOverlay
          serviceName={name}
          defaults={defaults}
          onConfirm={confirmDockerRebuild}
        />
      ),
    });
  }

  // Open the help overlay (keymap + version) — shared by `?` and the palette.
  function openHelp() {
    overlay.push({ id: HELP_OVERLAY_ID, render: () => <HelpOverlay /> });
  }

  // --- Palette action wiring: each command reuses the same IPC the quick keys
  // Drive, including the per-service busy guard, so it is never a second path. ---
  function runGuardedServiceAction(name: string, action: (n: string) => Promise<void>) {
    if (busyServices.current.has(name)) {
      return;
    }
    busyServices.current.add(name);
    void action(name)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        busyServices.current.delete(name);
      });
  }

  function runAllServicesAction(action: () => Promise<void>) {
    if (busyServices.current.size > 0) {
      return;
    }
    for (const s of sortedStatuses) {
      busyServices.current.add(s.name);
    }
    void action()
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        busyServices.current.clear();
      });
  }

  function zoomService(name: string) {
    const paneId = paneMap[name];
    if (paneId) {
      void zoomPane(paneId);
    }
  }

  function editCaptureService(name: string) {
    const paneId = paneMap[name];
    if (!paneId || busyServices.current.has(name)) {
      return;
    }
    busyServices.current.add(name);
    void editPaneCapture(paneId, name)
      .catch(() => {
        /* IPC error — ignore */
      })
      .finally(() => {
        busyServices.current.delete(name);
      });
  }

  function runTaskByKey(key: string) {
    if (runningTask) {
      return;
    }
    const task = tasks.find((t) => t.key === key);
    if (!task) {
      return;
    }
    // Optimistic running guard; task.start/complete events update history.
    setRunningTask(key);
    void client.runTask(key, {}).catch(() => {
      /* Task execution error handled by daemon */
    });
  }

  function openPalette() {
    const selected = sortedStatuses[dashboardSel.index];
    const commands = buildCommandRegistry({
      selected,
      tasks,
      actions: {
        restart: (n) => runGuardedServiceAction(n, restart),
        toggle: (n) => runGuardedServiceAction(n, toggle),
        restartAll: () => runAllServicesAction(restartAll),
        reloadConfig: () =>
          runAllServicesAction(async () => {
            await client.reloadConfig();
          }),
        openLogs: goToLogs,
        openUrl: (url) => {
          void openInBrowser(url);
        },
        rebuildDocker: openDockerRebuild,
        zoom: zoomService,
        editCapture: editCaptureService,
        runTask: runTaskByKey,
        detach: detachSession,
        shutdown: destroySession,
        help: openHelp,
      },
    });
    overlay.push({
      id: COMMAND_PALETTE_ID,
      render: () => <CommandPalette commands={commands} />,
    });
  }

  // Global keys — work from any base view, survive a disconnect, yield to overlays.
  useInput(
    (input, key) => {
      // Q / ctrl+c: detach from any view (services keep running). Works offline.
      if (input === "q" || (key.ctrl && input === "c")) {
        detachSession();
        return;
      }
      // While disconnected the UI is inert except `r` (manual re-attach). No
      // Auto-reconnect — `r` re-invokes client.connect(). The overlay-opening keys
      // Below are gated behind this so a disconnect can't push an overlay that the
      // Force-pop effect would then immediately clear (one-frame flash).
      if (!connected) {
        if (input === "r") {
          retry();
        }
        return;
      }
      // Ctrl-K / `:` opens the command palette; `?` opens help.
      if ((key.ctrl && input === "k") || input === ":") {
        openPalette();
        return;
      }
      if (input === "?") {
        openHelp();
        return;
      }
      // Ctrl+d: shut down — destroy session from any view.
      if (key.ctrl && input === "d") {
        destroySession();
      }
    },
    { isActive: flags.global },
  );

  // Dashboard input context — owned here, consumed by the Dashboard's own useInput.
  const dashboardInput: DashboardInputContext = {
    statuses: sortedStatuses,
    index: dashboardSel.index,
    busyServices,
    moveUp: dashboardSel.moveUp,
    moveDown: dashboardSel.moveDown,
    restart,
    toggle,
    restartAll,
    reloadConfig: async () => client.reloadConfig(),
    goToLogs,
    goToTasks,
    destroySession,
    paneMap,
    goToDockerRebuild: openDockerRebuild,
  };

  // Tasks view input (transitional — superseded by the Phase 4 picker overlay).
  useInput(
    (input, key) => {
      handleTasksInput(input, key, {
        tasks,
        taskShortcuts,
        taskCount: tasks.length,
        setIndex: tasksSel.setIndex,
        goToDashboard,
        moveUp: tasksSel.moveUp,
        moveDown: tasksSel.moveDown,
        setRunTrigger,
      });
    },
    { isActive: flags.tasks },
  );

  if (!ready) {
    return null;
  }

  // Disconnected: show the last-known dashboard with a sticky banner regardless
  // Of which view was active, so the lost connection is never a silent blank.
  if (!connected) {
    return (
      <Dashboard
        statuses={sortedStatuses}
        selectedIndex={dashboardSel.index}
        taskHistory={taskHistory}
        banner={<DisconnectBanner />}
        input={dashboardInput}
        inputActive={flags.dashboard}
      />
    );
  }

  // Conditional render — pass state as props
  if (view === "logs" && logTarget) {
    return (
      <LogView
        serviceName={logTarget}
        lines={logLines}
        autoScroll={logAutoScroll}
        offset={logOffset}
        onBack={goToDashboard}
        scrollUp={scrollUp}
        scrollDown={scrollDown}
        inputActive={flags.logs}
      />
    );
  }
  if (view === "tasks") {
    return (
      <TasksView
        selectedIndex={tasksSel.index}
        runTrigger={runTrigger}
        taskShortcuts={taskShortcuts}
        taskHistory={taskHistory}
        runningTask={runningTask}
        onRunStart={setRunningTask}
      />
    );
  }
  // Overlays (docker rebuild, palette, help) float above this base view via the
  // OverlayHost (mounted by AppShell), so the dashboard is the lone base render.
  return (
    <Dashboard
      statuses={sortedStatuses}
      selectedIndex={dashboardSel.index}
      taskHistory={taskHistory}
      input={dashboardInput}
      inputActive={flags.dashboard}
    />
  );
}
