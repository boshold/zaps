import type { TaskConfig } from "#src/config/types.js";
import { Box, Text } from "ink";

interface TaskRowProps {
  taskKey: string;
  task: TaskConfig;
  isSelected: boolean;
  result?: "success" | "error";
  isRunning: boolean;
  shortcut?: string;
}

function getIconAndColor(isRunning: boolean, result?: "success" | "error") {
  if (isRunning) {
    return { icon: "◐", color: "yellow" } as const;
  }
  if (result === "success") {
    return { icon: "✔", color: "green" } as const;
  }
  if (result === "error") {
    return { icon: "✖", color: "red" } as const;
  }
  return { icon: "○", color: "gray" } as const;
}

export function TaskRow({ task, isSelected, result, isRunning, shortcut }: TaskRowProps) {
  const { icon, color } = getIconAndColor(isRunning, result);

  return (
    <Box>
      <Text>{isSelected ? ">" : " "} </Text>
      <Text color={color}>{icon}</Text>
      {shortcut && <Text dimColor> [{shortcut}]</Text>}
      <Text> {task.name}</Text>
      {task.description && <Text dimColor> — {task.description}</Text>}
    </Box>
  );
}

export type { TaskRowProps };
