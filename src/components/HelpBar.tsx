import type { TaskShortcut } from "#src/lib/taskShortcuts.js";
import { Box, Text } from "ink";

export interface HelpBarProps {
  chordMode?: boolean;
  taskShortcuts?: TaskShortcut[];
}

export function HelpBar({ chordMode, taskShortcuts }: HelpBarProps) {
  if (chordMode && taskShortcuts) {
    const parts = taskShortcuts.map((t) => `[${t.shortcut}] ${t.name}`);
    return (
      <Box marginTop={1}>
        <Text dimColor>{parts.join(" ")} | [enter] all tasks [esc] back</Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text dimColor>[t]asks [a]ll restart [q]uit</Text>
    </Box>
  );
}
