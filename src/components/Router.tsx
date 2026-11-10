import { useApp as useInkApp, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DockerConfig, NoticeLevel, UiTaskMode } from "#src/config/types.js";
import type { SessionSnapshot } from "#src/daemon/session.js";
import { useInputRouter } from "#src/hooks/useInputRouter.js";
import { useLogs } from "#src/hooks/useLogs.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import { useRouter } from "#src/hooks/useRouter.js";
import { useSelection } from "#src/hooks/useSelection.js";
import { useServiceActions } from "#src/hooks/useServiceActions.js";
import { useToasts } from "#src/hooks/useToasts.js";
import { useZaps } from "#src/hooks/useZaps.js";
import {
  canLaunchTask,
  canRebuildDocker,
  canZoomDashboard,
  serviceAvailability,
} from "#src/lib/backend/capabilities.js";
import { buildCommandRegistry } from "#src/lib/command-registry.js";
import { detachManagedClient } from "#src/lib/managed-detach.js";
import { notifyFailure } from "#src/lib/notifier.js";
import { openInBrowser } from "#src/lib/open.js";
import { outputPopupAvailable, showOutputPopup } from "#src/lib/task/output-popup.js";
import { popupPickerAvailable, runPopupPicker } from "#src/lib/task/popup-picker.js";
import { editPaneCapture, zoomPane } from "#src/lib/tmux.js";

import { Dashboard } from "./Dashboard.js";
import type { DashboardInputContext } from "./dashboard/useDashboardInput.js";
import { DisconnectBanner } from "./DisconnectBanner.js";
import { LogView } from "./LogView.js";
import { COMMAND_PALETTE_ID, CommandPalette } from "./overlay/CommandPalette.js";
import { DOCKER_REBUILD_ID, DockerRebuildOverlay } from "./overlay/DockerRebuildOverlay.js";
import { FAILED_OUTPUT_ID, FailedOutputOverlay } from "./overlay/FailedOutputOverlay.js";
import { HELP_OVERLAY_ID, HelpOverlay } from "./overlay/HelpOverlay.js";
import { SHUTDOWN_CONFIRM_ID, ShutdownConfirmOverlay } from "./overlay/ShutdownConfirmOverlay.js";
import { TASK_PICKER_ID, TaskPicker } from "./overlay/TaskPicker.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

const MAX_HISTORY = 50;

export function Router({
  initialTaskHistory,
  autoStart,
}: {
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}) {
  const { view, logTarget, goToLogs, goToDashboard } = useRouter();
  const { client, paneMap, tasks, servicesMeta, ui, statuses, capabilities, connected, retry } =
    useZaps();
  // In-app notification surface: success → transient toast, failure → sticky.
  const { notify, ackAll, toasts, dismiss } = useToasts();
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

  // Dashboard selection — clamped against the (sorted) service list.
  const dashboardSel = useSelection(sortedStatuses.length);
  const selected = sortedStatuses[dashboardSel.index];

  const { exit } = useInkApp();
  const busyServices = useRef(new Set<string>());
  const selectedBusy = selected !== undefined && busyServices.current.has(selected.name);
  const globalBusyRef = useRef(false);

  // Logs state — now uses daemon client event stream
  const {
    lines: logLines,
    autoScroll: logAutoScroll,
    offset: logOffset,
    scrollUp,
    scrollDown,
  } = useLogs(client, logTarget);

  // Task run history — shared between the Dashboard and the task picker.
  const [taskHistory, setTaskHistory] = useState<TaskRunRecord[]>(initialTaskHistory);

  // Running-task state for the palette's background-run guard. Set optimistically
  // On dispatch + by the task.start event; cleared by task.complete (F4). The
  // Picker's per-key duplicate guard derives in-flight keys from taskHistory.
  const [runningTask, setRunningTask] = useState<string | null>(
    () => initialTaskHistory.find((record) => record.result === "running")?.taskKey ?? null,
  );

  function onTaskComplete(record: TaskRunRecord) {
    setTaskHistory((prev) => {
      if (record.result === "running") {
        return [record, ...prev].slice(0, MAX_HISTORY);
      }
      // Replace the matching in-flight entry by runId (so concurrent same-key
      // Runs resolve independently), or prepend if not found. taskKey is a
      // Secondary guard mirroring session.pushTaskRecord: on the manager/hook
      // Path a run's dep-graph completions share the run's runId, and must not
      // Clobber the top-level "running" record (they prepend as their own rows).
      const runningIdx = prev.findIndex(
        (r) => r.runId === record.runId && r.taskKey === record.taskKey && r.result === "running",
      );
      if (runningIdx !== -1) {
        const next = [...prev];
        next[runningIdx] = record;
        return next;
      }
      return [record, ...prev].slice(0, MAX_HISTORY);
    });
  }

  // Subscribe to daemon task events. `runId` correlates start↔complete; a missing
  // One (older daemon) falls back to the task key so behavior degrades to the
  // Pre-runId single-flight matching rather than breaking.
  useEffect(() => {
    function handleTaskStart(taskKey: string, taskName: string, runId?: string) {
      onTaskComplete({
        runId: runId ?? taskKey,
        taskKey,
        taskName,
        result: "running",
        timestamp: Date.now(),
      });
      setRunningTask(taskKey);
    }
    function handleTaskComplete(
      taskKey: string,
      taskName: string,
      result: "success" | "error",
      runId?: string,
    ) {
      onTaskComplete({ runId: runId ?? taskKey, taskKey, taskName, result, timestamp: Date.now() });
      setRunningTask((cur) => (cur === taskKey ? null : cur));
      // In-app signal that a background run finished. Success is transient;
      // Failure is sticky and carries the runId so the overlay (P05-T05) can
      // Open its captured output.
      notify({
        level: result === "error" ? "error" : "success",
        message: result === "error" ? `${taskName} failed` : `${taskName} succeeded`,
        runId: runId ?? null,
        sticky: result === "error",
      });
      // Out-of-band desktop/terminal nudge on failure, per ui.notifications.
      // Unconditional (no focus gate, Q6); complements the sticky toast above.
      if (result === "error") {
        notifyFailure(taskName, ui.notifications);
      }
    }
    function handleSnapshot(snapshot: SessionSnapshot) {
      setTaskHistory(snapshot.taskHistory);
      setRunningTask(
        snapshot.taskHistory.find((record) => record.result === "running")?.taskKey ?? null,
      );
    }
    client.on("session.snapshot", handleSnapshot);
    client.on("session.configReloaded", handleSnapshot);
    client.on("task.start", handleTaskStart);
    client.on("task.complete", handleTaskComplete);
    return () => {
      client.off("session.snapshot", handleSnapshot);
      client.off("session.configReloaded", handleSnapshot);
      client.off("task.start", handleTaskStart);
      client.off("task.complete", handleTaskComplete);
    };
  }, [client, notify, ui.notifications]);

  // Surface config-eval notices (cli.warn/info/success during a daemon reload)
  // As transient toasts. `warn` has no ToastLevel, so it maps to `info`.
  useEffect(() => {
    function handleConfigNotice(level: NoticeLevel, message: string) {
      notify({
        level: level === "warn" ? "info" : level,
        message,
        runId: null,
        sticky: false,
      });
    }
    client.on("config.notice", handleConfigNotice);
    client.deliverUpgradeNotice();
    return () => {
      client.off("config.notice", handleConfigNotice);
    };
  }, [client, notify]);

  // Ready gate: delay rendering for minimum splash time only
  const [ready, setReady] = useState(!autoStart);

  useEffect(() => {
    if (!autoStart) {
      return;
    }
    const timer = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(timer);
  }, [autoStart]);

  // Overlay callbacks can outlive the render that opened them.
  const current = {
    capabilities,
    connected,
    statuses,
    servicesMeta,
    paneMap,
    tasks,
    taskHistory,
    runningTask,
    ui,
  };
  const latest = useRef(current);
  useLayoutEffect(() => {
    latest.current = current;
  });

  function availabilityFor(name: string) {
    const state = latest.current;
    const status = state.connected
      ? state.statuses.find((entry) => entry.name === name)
      : undefined;
    return {
      ...serviceAvailability(state.capabilities, status, busyServices.current.has(name)),
      paneId: status?.paneId,
    };
  }

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

  // Every shutdown entry point (Ctrl-D, dashboard `d`, palette) goes through
  // Here: destroying the session is irreversible, and the pane's stdin is not a
  // Trusted source of intent — a tmux client attaching with its own stdin at EOF
  // Makes the pty emit `VEOF` (0x04), which tmux delivers to the pane as Ctrl-D.
  // One key must never be enough; the overlay asks for a second, distinct one.
  function confirmShutdown() {
    if (globalBusyRef.current || overlay.isTop(SHUTDOWN_CONFIRM_ID)) {
      return;
    }
    overlay.push({
      id: SHUTDOWN_CONFIRM_ID,
      render: () => <ShutdownConfirmOverlay onConfirm={destroySession} />,
    });
  }

  // Detach (services keep running) — shared by `q`/Ctrl-C and the palette.
  // In a zaps-managed tmux the client is detached first, so quitting drops the
  // User back into their plain shell; in a personal tmux this is a no-op.
  function detachSession() {
    if (globalBusyRef.current) {
      return;
    }
    globalBusyRef.current = true;
    void detachManagedClient().finally(() => {
      client.disconnect();
      exit();
    });
  }

  function runGuardedServiceAction(name: string, action: (n: string) => Promise<void>) {
    if (!availabilityFor(name).control) {
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

  function rebuildMetadata(name: string) {
    const meta = latest.current.servicesMeta.find((entry) => entry.name === name);
    if (meta && canRebuildDocker(meta.hasDocker, meta.group) && availabilityFor(name).rebuild) {
      return meta;
    }
  }

  function confirmDockerRebuild(name: string, overrides: Partial<DockerConfig>) {
    if (rebuildMetadata(name)) {
      runGuardedServiceAction(name, async () => rebuildDocker(name, overrides));
    }
  }

  // Open the docker-rebuild overlay with this service's defaults preloaded —
  // Shared by the dashboard `R` key and the palette's rebuild command.
  function openDockerRebuild(name: string) {
    const meta = rebuildMetadata(name);
    if (!meta) {
      return;
    }
    overlay.push({
      id: DOCKER_REBUILD_ID,
      render: () => (
        <DockerRebuildOverlay
          serviceName={name}
          defaults={meta.dockerDefaults}
          onConfirm={confirmDockerRebuild}
        />
      ),
    });
  }

  // Open the help overlay (keymap + version) — shared by `?` and the palette.
  function openHelp() {
    const selectedName = selected?.name;
    overlay.push({
      id: HELP_OVERLAY_ID,
      render: () => <HelpOverlay selectedName={selectedName} busyServices={busyServices} />,
    });
  }

  // Acknowledge a single failure by clearing its sticky toast(s) (the overlay
  // Calls this on close). dismiss-by-id is safe even against a stale list.
  function dismissFailureToast(runId: string) {
    for (const toast of toasts) {
      if (toast.runId === runId && toast.sticky) {
        dismiss(toast.id);
      }
    }
  }

  // Stable fetcher identity so an OverlayHost re-render (e.g. on terminal RESIZE)
  // Doesn't change the failed-output overlay's load-effect deps — which would
  // Otherwise re-fetch and snap the user's scroll back to the tail.
  const fetchTaskOutput = useCallback(async (id: string) => client.getTaskOutput(id), [client]);

  // Open the failed-output overlay for a run (entry point from the `f` key on a
  // Sticky failure). Resolves popup availability first so the overlay only offers
  // Escalation when tmux supports it. With `ui.failOutput: popup` the overlay
  // Escalates straight to the popup on open (Q3). Closing acks the sticky toast.
  function openFailedOutput(runId: string, taskName: string) {
    void (async () => {
      const canPopup = latest.current.capabilities.popups && (await outputPopupAvailable());
      if (!latest.current.connected) {
        return;
      }
      async function showPopup(title: string, lines: string[]) {
        if (!latest.current.connected || !latest.current.capabilities.popups) {
          throw new Error("Popup unavailable");
        }
        await showOutputPopup(title, lines);
      }
      overlay.push({
        id: FAILED_OUTPUT_ID,
        render: () => (
          <FailedOutputOverlay
            runId={runId}
            taskName={taskName}
            fetchOutput={fetchTaskOutput}
            showPopup={canPopup ? showPopup : undefined}
            startInPopup={ui.failOutput === "popup"}
            onClose={() => dismissFailureToast(runId)}
          />
        ),
      });
    })();
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
    const { zoom, paneId } = availabilityFor(name);
    if (zoom && paneId) {
      void zoomPane(paneId);
    }
  }

  function zoomDashboard() {
    const state = latest.current;
    const paneId = state.paneMap["@tui"];
    if (state.connected && canZoomDashboard(state.capabilities) && paneId) {
      void zoomPane(paneId);
    }
  }

  function editCaptureService(name: string) {
    const { editOutput, paneId } = availabilityFor(name);
    if (editOutput && paneId) {
      runGuardedServiceAction(name, async () => editPaneCapture(paneId, name));
    }
  }

  function runTaskByKey(key: string) {
    const state = latest.current;
    if (!state.connected || state.runningTask || !state.tasks.some((task) => task.key === key)) {
      return;
    }
    // Optimistic running guard; task.start/complete events update history.
    setRunningTask(key);
    void client.runTask(key, {}).catch(() => {
      /* Task execution error handled by daemon */
    });
  }

  function taskIsRunning(key: string) {
    return latest.current.taskHistory.some(
      (run) => run.taskKey === key && run.result === "running",
    );
  }

  function launchTask(key: string, mode: UiTaskMode) {
    const state = latest.current;
    if (
      !state.connected ||
      !canLaunchTask(mode, state.capabilities) ||
      !state.tasks.some((task) => task.key === key) ||
      taskIsRunning(key)
    ) {
      return;
    }
    if (mode === "pane") {
      void client.runTaskInPane(key).catch(() => {
        /* Tmux/IPC error handled by daemon */
      });
    } else {
      void client.runTask(key, {}).catch(() => {
        /* Task execution error handled by daemon */
      });
    }
  }

  function openInAppTaskPicker() {
    if (latest.current.connected) {
      overlay.push({
        id: TASK_PICKER_ID,
        render: () => <TaskPicker isRunning={taskIsRunning} onRun={launchTask} />,
      });
    }
  }

  // `t` opens the task picker. With `ui.task.popupPicker` enabled AND a capable
  // Host (tmux >= 3.2 + fzf), launch fzf in a tmux popup and run the pick in the
  // Background. Otherwise — and on any popup failure or a missing dependency —
  // Fall back to the in-app TaskPicker, which stays the primary path (P04-T04).
  function openTaskPicker() {
    if (!ui.task.popupPicker || !capabilities.popups) {
      openInAppTaskPicker();
      return;
    }
    void (async () => {
      try {
        const available = await popupPickerAvailable();
        const state = latest.current;
        if (
          available &&
          state.connected &&
          state.capabilities.popups &&
          state.ui.task.popupPicker
        ) {
          const key = await runPopupPicker(state.tasks);
          if (key) {
            launchTask(key, "background");
          }
          return;
        }
      } catch {
        /* Popup failed — fall through to the in-app picker */
      }
      openInAppTaskPicker();
    })();
  }

  function openPalette() {
    const commands = buildCommandRegistry({
      selected,
      selectedBusy: selected !== undefined && busyServices.current.has(selected.name),
      capabilities,
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
          void openInBrowser(url).catch(() => undefined);
        },
        rebuildDocker: openDockerRebuild,
        zoom: zoomService,
        editCapture: editCaptureService,
        runTask: runTaskByKey,
        detach: detachSession,
        shutdown: confirmShutdown,
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
      // X: acknowledge — clear sticky failure toasts. Works offline (toasts are
      // Local state) and from any view; harmless when nothing is sticky.
      if (input === "x") {
        ackAll();
        return;
      }
      // While disconnected the UI is inert except `r` (manual re-attach). No
      // Auto-reconnect — `r` repeats the UI handshake. The overlay-opening keys
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
      // F: open the most-recent sticky failure's captured output overlay. The
      // Task name is recovered from history by runId. No-op when none is sticky.
      if (input === "f") {
        const failure = toasts.toReversed().find((t) => t.sticky && Boolean(t.runId));
        if (failure?.runId) {
          const record = taskHistory.find((r) => r.runId === failure.runId);
          openFailedOutput(failure.runId, record?.taskName ?? "Task");
        }
        return;
      }
      // Ctrl+d: shut down — asks for confirmation first, from any view.
      if (key.ctrl && input === "d") {
        confirmShutdown();
      }
    },
    { isActive: flags.global },
  );

  // Dashboard input context — owned here, consumed by the Dashboard's own useInput.
  const dashboardInput: DashboardInputContext = {
    statuses: sortedStatuses,
    capabilities,
    index: dashboardSel.index,
    busyServices,
    moveUp: dashboardSel.moveUp,
    moveDown: dashboardSel.moveDown,
    restart,
    toggle,
    restartAll,
    reloadConfig: async () => client.reloadConfig(),
    goToLogs,
    openTaskPicker,
    destroySession: confirmShutdown,
    zoomService,
    zoomDashboard,
    editCaptureService,
    goToDockerRebuild: openDockerRebuild,
  };

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
        selectedBusy={selectedBusy}
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
  // Overlays (docker rebuild, palette, help) float above this base view via the
  // OverlayHost (mounted by AppShell), so the dashboard is the lone base render.
  return (
    <Dashboard
      statuses={sortedStatuses}
      selectedIndex={dashboardSel.index}
      selectedBusy={selectedBusy}
      taskHistory={taskHistory}
      input={dashboardInput}
      inputActive={flags.dashboard}
    />
  );
}
