import { Text } from "ink";

import type { TaskInfo } from "#src/daemon/session.js";

import type { IconTheme } from "./theme/IconTheme.js";
import { useIcons } from "./theme/IconTheme.js";

interface TaskRowProps {
  task: TaskInfo;
  isSelected: boolean;
  result?: "success" | "error";
  isRunning: boolean;
  shortcut?: string;
  maxWidth?: number;
}

function getIconAndColor(icons: IconTheme, isRunning: boolean, result?: "success" | "error") {
  if (isRunning) {
    return { icon: icons.icon("working"), color: "yellow" } as const;
  }
  if (result === "success") {
    return { icon: icons.icon("taskSuccess"), color: "green" } as const;
  }
  if (result === "error") {
    return { icon: icons.icon("taskError"), color: "red" } as const;
  }
  return { icon: icons.icon("taskPending"), color: "gray" } as const;
}

function truncate(str: string, max: number, ellipsis: string): string {
  if (str.length <= max) {
    return str;
  }
  return `${str.slice(0, Math.max(0, max - ellipsis.length))}${ellipsis}`;
}

export function TaskRow({ task, isSelected, result, isRunning, shortcut, maxWidth }: TaskRowProps) {
  const icons = useIcons();
  const { icon, color } = getIconAndColor(icons, isRunning, result);
  const cursor = isSelected ? ">" : " ";

  // Build the full text to compute truncation
  const shortcutPart = shortcut ? ` [${shortcut}]` : "";
  const descPart = task.description ? ` ${icons.icon("dash")} ${task.description}` : "";
  const tail = `${shortcutPart} ${task.name}${descPart}`;

  // Prefix is "X Y" where X=cursor, Y=icon — always 3 chars
  const prefixLen = 3;
  const available = maxWidth !== undefined ? Math.max(0, maxWidth - prefixLen) : tail.length;
  const truncatedTail = truncate(tail, available, icons.icon("ellipsis"));

  // Split truncatedTail back into shortcut / name / desc portions for coloring
  // ShortcutPart is fixed-length if present, so we can slice deterministically
  let remainingTail = truncatedTail;
  let displayShortcut = "";
  if (shortcut && remainingTail.startsWith(` [${shortcut}]`)) {
    displayShortcut = ` [${shortcut}]`;
    remainingTail = remainingTail.slice(displayShortcut.length);
  } else if (shortcut && remainingTail.length > 0) {
    // Shortcut got truncated — just render all as plain
    return (
      <Text>
        <Text>{cursor} </Text>
        <Text color={color}>{icon}</Text>
        <Text dimColor>{truncatedTail}</Text>
      </Text>
    );
  }

  // RemainingTail is " taskname — desc" or truncated version
  const namePart = ` ${task.name}`;
  if (remainingTail.length <= namePart.length || !task.description) {
    // Only name (possibly truncated), no desc portion
    return (
      <Text>
        <Text>{cursor} </Text>
        <Text color={color}>{icon}</Text>
        {displayShortcut && <Text dimColor>{displayShortcut}</Text>}
        <Text>{remainingTail}</Text>
      </Text>
    );
  }

  // Has both name and (possibly truncated) description
  const displayDesc = remainingTail.slice(namePart.length);
  return (
    <Text>
      <Text>{cursor} </Text>
      <Text color={color}>{icon}</Text>
      {displayShortcut && <Text dimColor>{displayShortcut}</Text>}
      <Text>{namePart}</Text>
      <Text dimColor>{displayDesc}</Text>
    </Text>
  );
}

export type { TaskRowProps };
