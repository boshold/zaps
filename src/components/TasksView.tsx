import type { TaskConfig } from "#src/config/types.js";
import { useServices } from "#src/hooks/useServices.js";
import { useZaps } from "#src/hooks/useZaps.js";
import { execCommand } from "#src/lib/exec.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
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

  async function runWithDeps(
    key: string,
    allTasks: Record<string, TaskConfig>,
    visited: Set<string>,
    projectDir: string,
    currentStatuses: ServiceStatus[],
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
        // eslint-disable-next-line no-await-in-loop -- Sequential dependency execution
        if (!(await runWithDeps(dep, allTasks, visited, projectDir, currentStatuses))) {
          return false;
        }
      }
    }

    if (taskResultsRef.current[key] === "success") {
      return true;
    }

    // Resolve env
    const statusMap = new Map(currentStatuses.map((s) => [s.name, s]));
    const ctx = buildServiceContext(statusMap, projectDir);
    const resolvedEnv = resolveEnv(t.env, ctx);

    // Run commands
    const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
    for (const cmd of commands) {
      const resolved = typeof cmd === "function" ? cmd() : cmd;
      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential command execution
        await execCommand(resolved, {
          cwd: t.cwd ?? projectDir,
          ...(Object.keys(resolvedEnv).length > 0 && { env: resolvedEnv }),
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
    await runWithDeps(taskKey, allTasks, visited, config.projectDir, statuses);
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
