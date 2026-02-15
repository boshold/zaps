import type { TaskConfig } from "#src/config/types.js";
import { Box, Text } from "ink";

import { TaskRow } from "./TaskRow.js";

interface TaskListPanelProps {
  tasks: [string, TaskConfig][];
  selectedIndex: number;
  taskResults: Record<string, "success" | "error">;
  runningTask: string | null;
}

export function TaskListPanel({
  tasks,
  selectedIndex,
  taskResults,
  runningTask,
}: TaskListPanelProps) {
  return (
    <Box flexDirection="column" width="40%">
      <Box flexDirection="column" flexGrow={1}>
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
      <Box marginTop={1}>
        <Text dimColor>[↑/↓] select [enter] run [esc] back</Text>
      </Box>
    </Box>
  );
}
