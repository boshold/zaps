// eslint-disable-next-line import/no-relative-parent-imports -- Components need config types
import type { TaskConfig } from "../config/types.js";
import { Box, Text } from "ink";

export interface TaskRowProps {
  taskKey: string;
  task: TaskConfig;
  isSelected: boolean;
  result?: "success" | "error";
  isRunning: boolean;
}

export function TaskRow({ task, isSelected, result, isRunning }: TaskRowProps) {
  const icon = isRunning ? "◐" : result === "success" ? "✔" : result === "error" ? "✖" : "○";
  const color = isRunning ? "yellow" : result === "success" ? "green" : result === "error" ? "red" : "gray";

  return (
    <Box>
      <Text>{isSelected ? ">" : " "} </Text>
      <Text color={color}>{icon}</Text>
      <Text> {task.name}</Text>
      {task.description && <Text dimColor> — {task.description}</Text>}
    </Box>
  );
}
