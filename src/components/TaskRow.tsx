import type { TaskInfo } from "#src/daemon/session.js";
import { Box, Text } from "ink";

interface TaskRowProps {
  task: TaskInfo;
  isSelected: boolean;
  result?: "success" | "error";
  isRunning: boolean;
  shortcut?: string;
  maxWidth?: number;
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

export function TaskRow({ task, isSelected, result, isRunning, shortcut, maxWidth }: TaskRowProps) {
  const { icon, color } = getIconAndColor(isRunning, result);

  if (maxWidth !== undefined && maxWidth < 40) {
    // Narrow: just icon + name, truncated
    return (
      <Box>
        <Text>{isSelected ? ">" : " "} </Text>
        <Text color={color}>{icon}</Text>
        <Text wrap="truncate"> {task.name}</Text>
      </Box>
    );
  }

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
