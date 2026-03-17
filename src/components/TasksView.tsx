import { useDimensions } from "#src/hooks/useDimensions.js";
import { useZaps } from "#src/hooks/useZaps.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import { Box } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
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
  const { cols, rows, compact, narrow } = useDimensions();
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

  // Chrome: Header(1-2) + padding(2) + margin(1) + help(1) = 5-6
  const chromeRows = compact ? 4 : 6;
  const visibleLines = Math.max(1, rows - chromeRows);

  return (
    <Box height={rows} flexDirection="column" padding={1}>
      <Header projectName="Tasks" statuses={[]} width={cols - 2} compact={compact} />
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        <TaskListPanel
          tasks={tasks}
          selectedIndex={selectedIndex}
          taskResults={taskResults}
          runningTask={runningTask}
          taskShortcuts={taskShortcuts}
          taskHistory={taskHistory}
          maxRows={visibleLines}
          compact={compact}
          cols={narrow ? cols - 2 : undefined}
        />
        {!narrow && <TaskOutputPanel lines={taskOutput} visibleLines={visibleLines} />}
      </Box>
    </Box>
  );
}
