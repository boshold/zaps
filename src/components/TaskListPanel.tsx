import type { TaskConfig } from "#src/config/types.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import { Box, Text } from "ink";

import { TaskRow } from "./TaskRow.js";

interface TaskListPanelProps {
  tasks: [string, TaskConfig][];
  selectedIndex: number;
  taskResults: Record<string, "success" | "error">;
  runningTask: string | null;
  taskShortcuts: TaskShortcut[];
}

export function TaskListPanel({
  tasks,
  selectedIndex,
  taskResults,
  runningTask,
  taskShortcuts,
}: TaskListPanelProps) {
  const shortcutMap = new Map(taskShortcuts.map((s) => [s.name, s.shortcut]));

  return (
    <Box flexDirection="column" flexShrink={0} marginRight={1}>
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map(([key, task], i) => (
          <TaskRow
            key={key}
            taskKey={key}
            task={task}
            isSelected={i === selectedIndex}
            result={taskResults[key]}
            isRunning={runningTask === key}
            shortcut={shortcutMap.get(task.name)}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[j/k/↑/↓] select [enter] run [key] shortcut [q/esc] back</Text>
      </Box>
    </Box>
  );
}
