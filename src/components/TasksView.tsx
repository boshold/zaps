import { useDimensions } from "#src/hooks/useDimensions.js";
import { useZaps } from "#src/hooks/useZaps.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import { Box } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
import { TaskHistorySection } from "./TaskHistorySection.js";
import { TaskListPanel } from "./TaskListPanel.js";
import { TaskOutputPanel } from "./TaskOutputPanel.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

export interface TasksViewProps {
  selectedIndex: number;
  runTrigger: number;
  taskShortcuts: TaskShortcut[];
  taskHistory: TaskRunRecord[];
}

export function TasksView({
  selectedIndex,
  runTrigger,
  taskShortcuts,
  taskHistory,
}: TasksViewProps) {
  const { client, tasks } = useZaps();
  const { cols, rows, compact, medium } = useDimensions();
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [taskOutput, setTaskOutput] = useState<string[]>([]);
  const [taskResults, setTaskResults] = useState<Record<string, "success" | "error">>({});
  const taskResultsRef = useRef<Record<string, "success" | "error">>({});
  const runningRef = useRef(false);

  async function runTask(taskKey: string) {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunningTask(taskKey);
    setTaskOutput([]);

    try {
      await client.runTask(taskKey, {
        onLine: (line) => {
          setTaskOutput((prev) => [...prev, line]);
        },
        onProgress: (key, result) => {
          taskResultsRef.current[key] = result;
          setTaskResults((prev) => ({ ...prev, [key]: result }));
        },
      });
    } catch {
      /* Task execution error handled by daemon */
    }

    setRunningTask(null);
    runningRef.current = false;
  }

  const prevTrigger = useRef(runTrigger);
  useEffect(() => {
    if (runTrigger === prevTrigger.current) {
      return;
    }
    prevTrigger.current = runTrigger;

    const task = tasks[selectedIndex];
    if (!task || runningRef.current) {
      return;
    }

    void runTask(task.key);
  }, [runTrigger]); // eslint-disable-line react-hooks/exhaustive-deps -- Only trigger on runTrigger

  // Medium/narrow: hide header entirely. Wide: header + separator.
  const showHeader = !medium;
  // Chrome: padding(2) + help(0-1) + header(0 or 2) + margin(0-1)
  let chromeRows = 2; // Padding always
  if (showHeader) {
    chromeRows += 4; // Header(1) + separator(1) + margin(1) + help(1)
  } else if (!compact) {
    chromeRows += 2; // Help(1) + margin-equivalent(1)
  } else {
    chromeRows += 1;
  }
  const visibleLines = Math.max(1, rows - chromeRows);

  // Inner width = cols - 2 (padding).
  const innerWidth = cols - 2;
  // Medium/narrow: history as side panel, no output
  // Wide (>= 100): task list ~40% + output panel
  const showSideHistory = medium && !compact && taskHistory.length > 0;
  const historyPanelWidth = showSideHistory ? Math.max(16, Math.round(innerWidth * 0.35)) : 0;
  const listPanelWidth = medium
    ? innerWidth - historyPanelWidth
    : Math.max(20, Math.min(50, Math.round(innerWidth * 0.4)));

  return (
    <Box height={rows} flexDirection="column" padding={1}>
      {showHeader && <Header projectName="Tasks" statuses={[]} width={cols - 2} compact={false} />}
      <Box flexDirection="row" flexGrow={1} marginTop={showHeader ? 1 : 0}>
        <TaskListPanel
          tasks={tasks}
          selectedIndex={selectedIndex}
          taskResults={taskResults}
          runningTask={runningTask}
          taskShortcuts={taskShortcuts}
          taskHistory={taskHistory}
          maxRows={visibleLines}
          compact={compact}
          width={listPanelWidth}
          showHistory={!showSideHistory}
        />
        {showSideHistory && (
          <TaskHistorySection
            title="History"
            history={taskHistory}
            limit={10}
            maxWidth={historyPanelWidth}
            width={historyPanelWidth}
          />
        )}
        {!medium && <TaskOutputPanel lines={taskOutput} visibleLines={visibleLines} />}
      </Box>
    </Box>
  );
}
