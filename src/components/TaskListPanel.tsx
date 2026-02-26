import type { TaskInfo } from "#src/daemon/session.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, Text } from "ink";

import { TaskHistorySection } from "./TaskHistorySection.js";
import { TaskRow } from "./TaskRow.js";

interface TaskListPanelProps {
  tasks: TaskInfo[];
  selectedIndex: number;
  taskResults: Record<string, "success" | "error">;
  runningTask: string | null;
  taskShortcuts: TaskShortcut[];
  taskHistory: TaskRunRecord[];
}

export function TaskListPanel({
  tasks,
  selectedIndex,
  taskResults,
  runningTask,
  taskShortcuts,
  taskHistory,
}: TaskListPanelProps) {
  const shortcutMap = new Map(taskShortcuts.map((s) => [s.name, s.shortcut]));

  return (
    <Box flexDirection="column" flexShrink={0} marginRight={1}>
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map((task, i) => (
          <TaskRow
            key={task.key}
            task={task}
            isSelected={i === selectedIndex}
            result={taskResults[task.key]}
            isRunning={runningTask === task.key}
            shortcut={shortcutMap.get(task.name)}
          />
        ))}
      </Box>
      <TaskHistorySection title="History" history={taskHistory} limit={10} />
      <Box marginTop={1}>
        <Text dimColor>[j/k/↑/↓] select [enter] run [key] shortcut [esc] back</Text>
      </Box>
    </Box>
  );
}
