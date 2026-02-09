// eslint-disable-next-line import/no-relative-parent-imports -- Components need config types
import type { TaskConfig } from "../config/types.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need exec helper
import { execCommand } from "../lib/exec.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need app context
import { useZaps } from "../hooks/useZaps.js";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import { Header } from "./Header.js";
import { TaskRow } from "./TaskRow.js";

export interface TasksViewProps {
  selectedIndex: number;
  runTrigger: number;
}

export function TasksView({ selectedIndex, runTrigger }: TasksViewProps) {
  const { config } = useZaps();
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
    // eslint-disable-next-line no-void -- Fire-and-forget; React effect cannot return promise
    void runTask(taskKey);
  }, [runTrigger]); // eslint-disable-line react-hooks/exhaustive-deps -- Only trigger on runTrigger

  async function runWithDeps(
    key: string,
    allTasks: Record<string, TaskConfig>,
    visited: Set<string>,
    projectDir: string,
  ): Promise<boolean> {
    if (visited.has(key)) {
      return taskResultsRef.current[key] === "success";
    }
    visited.add(key);

    const t = allTasks[key];
    if (!t) {
      throw new Error(`Unknown task dependency: ${key}`);
    }

    // Run deps first
    if (t.dependsOn) {
      for (const dep of t.dependsOn) {
        // eslint-disable-next-line no-await-in-loop -- Dependencies must run sequentially
        if (!(await runWithDeps(dep, allTasks, visited, projectDir))) {
          return false;
        }
      }
    }

    if (taskResultsRef.current[key] === "success") {
      return true;
    }

    // Run commands
    const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
    for (const cmd of commands) {
      const resolved = typeof cmd === "function" ? cmd() : cmd;
      try {
        // eslint-disable-next-line no-await-in-loop -- Commands must run sequentially
        await execCommand(resolved, {
          cwd: t.cwd ?? projectDir,
          onLine: (line) => {
            setTaskOutput((prev) => [...prev, line]);
          },
        });
      } catch {
        taskResultsRef.current[key] = "error";
        setTaskResults((prev) => ({ ...prev, [key]: "error" }));
        return false;
      }
    }
    taskResultsRef.current[key] = "success";
    setTaskResults((prev) => ({ ...prev, [key]: "success" }));
    return true;
  }

  async function runTask(taskKey: string) {
    if (runningRef.current) {
      return; // Prevent concurrent task execution
    }
    runningRef.current = true;
    setRunningTask(taskKey);
    setTaskOutput([]);

    const allTasks = config.project.tasks ?? {};
    const visited = new Set<string>();
    await runWithDeps(taskKey, allTasks, visited, config.projectDir);
    setRunningTask(null);
    runningRef.current = false;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header projectName="Tasks" />
      <Box flexDirection="column" marginTop={1}>
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
        <Box flexDirection="column" marginTop={1} borderStyle="single">
          {taskOutput.slice(-10).map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key -- Output lines have no stable ID
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>[↑/↓] select  [enter] run  [esc] back</Text>
      </Box>
    </Box>
  );
}
