import type { TaskConfig } from "#src/config/types.js";

export interface TaskShortcut {
  shortcut: string;
  name: string;
}

export function getTaskShortcuts(tasks: Record<string, TaskConfig>): TaskShortcut[] {
  const used = new Set<string>();
  const result: TaskShortcut[] = [];

  for (const [key, task] of Object.entries(tasks)) {
    let { shortcut } = task;
    if (!shortcut) {
      // Auto-assign: first unique char from key
      for (const ch of key) {
        if (!used.has(ch)) {
          shortcut = ch;
          break;
        }
      }
    }
    if (shortcut && !used.has(shortcut)) {
      used.add(shortcut);
      result.push({ shortcut, name: task.name });
    }
  }

  return result;
}
