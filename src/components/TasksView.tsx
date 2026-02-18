import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import { Box, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
import { TaskListPanel } from "./TaskListPanel.js";
import { TaskOutputPanel } from "./TaskOutputPanel.js";

export interface TasksViewProps {
  selectedIndex: number;
  runTrigger: number;
  taskShortcuts: TaskShortcut[];
}

export function TasksView({ selectedIndex, runTrigger, taskShortcuts }: TasksViewProps) {
  const { config, manager } = useZaps();
  const statuses = useServices(manager);
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const tasks = Object.entries(config.project.tasks ?? {});
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

    const entry = tasks[selectedIndex];
    if (!entry || runningRef.current) {
      return;
    }

    const [taskKey] = entry;
    // eslint-disable-next-line no-void -- Fire-and-forget promise
    void runTask(taskKey);
  }, [runTrigger]); // eslint-disable-line react-hooks/exhaustive-deps -- Only trigger on runTrigger

  async function runTask(taskKey: string) {
    if (runningRef.current) {
      return; // Prevent concurrent task execution
    }
    runningRef.current = true;
    setRunningTask(taskKey);
    setTaskOutput([]);

    const allTasks = config.project.tasks ?? {};
    const statusMap = new Map(statuses.map((s) => [s.name, s]));
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps(
      taskKey,
      {
        tasks: allTasks,
        statuses: statusMap,
        projectDir: config.projectDir,
        onProgress: (key, result) => {
          taskResultsRef.current[key] = result;
          setTaskResults((prev) => ({ ...prev, [key]: result }));
        },
        onLine: (_key, line) => {
          setTaskOutput((prev) => [...prev, line]);
        },
      },
      visited,
      results,
    );

    setRunningTask(null);
    runningRef.current = false;
  }

  const termHeight = stdout?.rows ?? 24;
  const visibleLines = termHeight - 6; // Header + help bar + padding + borders

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName="Tasks" statuses={[]} width={termCols} />
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        <TaskListPanel
          tasks={tasks}
          selectedIndex={selectedIndex}
          taskResults={taskResults}
          runningTask={runningTask}
          taskShortcuts={taskShortcuts}
        />
        <TaskOutputPanel
          lines={taskOutput}
          visibleLines={visibleLines}
          width={Math.floor(termCols * 0.6) - 4}
        />
      </Box>
    </Box>
  );
}
