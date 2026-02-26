import { useZaps } from "#src/hooks/useZaps.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
import { TaskListPanel } from "./TaskListPanel.js";
import { TaskOutputPanel } from "./TaskOutputPanel.js";

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
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [taskOutput, setTaskOutput] = useState<string[]>([]);
  const [taskResults, setTaskResults] = useState<Record<string, "success" | "error">>({});
  const taskResultsRef = useRef<Record<string, "success" | "error">>({});
  const runningRef = useRef(false);

  // Trigger task run when runTrigger changes (from Router Enter key)
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

  async function runTask(taskKey: string) {
    if (runningRef.current) {
      return; // Prevent concurrent task execution
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

  const termHeight = stdout?.rows ?? 24;
  const visibleLines = termHeight - 6; // Header + help bar + padding + borders

  return (
    <Box height={termHeight} flexDirection="column" padding={1}>
      <Header projectName="Tasks" statuses={[]} width={termCols - 2} />
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        <TaskListPanel
          tasks={tasks}
          selectedIndex={selectedIndex}
          taskResults={taskResults}
          runningTask={runningTask}
          taskShortcuts={taskShortcuts}
          taskHistory={taskHistory}
        />
        <TaskOutputPanel lines={taskOutput} visibleLines={visibleLines} />
      </Box>
    </Box>
  );
}
