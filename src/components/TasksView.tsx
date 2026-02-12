import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";
import { Box, Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
import { TaskRow } from "./TaskRow.js";

export interface TasksViewProps {
  selectedIndex: number;
  runTrigger: number;
}

export function TasksView({ selectedIndex, runTrigger }: TasksViewProps) {
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

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName="Tasks" statuses={[]} width={termCols} />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {tasks.map(([key, task], i) => (
          <TaskRow
            key={key}
            taskKey={key}
            task={task}
            isSelected={i === selectedIndex}
            result={taskResults[key]}
            isRunning={runningTask === key}
          />
        ))}
      </Box>
      {taskOutput.length > 0 && (
        <Box flexDirection="column" flexGrow={1} marginTop={1} borderStyle="single">
          {taskOutput.slice(-10).map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key -- Log lines have no stable key
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>[↑/↓] select [enter] run [esc] back</Text>
      </Box>
    </Box>
  );
}
