import type { TaskConfig } from "#src/config/types.js";

export interface TaskShortcut {
  shortcut: string;
  name: string;
}

// Reserved keys: the only plain keys consumed before shortcut matching reaches the tasks view.
// Global `q` quits (Router global handler); tasks-view `j`/`k` navigate the list.
// Reserved keys are never auto-assigned, and explicit collisions are dropped (no fallback).
// Config validation in src/config/loader.ts emits the load-time warning for dropped collisions.
// Keep this set in sync with Router's key bindings if those plain keys ever change.
export const RESERVED_TASK_SHORTCUT_KEYS = new Set(["q", "j", "k"]);

export function getTaskShortcuts(tasks: Record<string, TaskConfig>): TaskShortcut[] {
  const used = new Set<string>();
  const result: TaskShortcut[] = [];

  for (const [key, task] of Object.entries(tasks)) {
    let { shortcut } = task;
    if (shortcut) {
      // Explicit shortcut colliding with a reserved key is dropped with no fallback.
      // Config validation emits a load-time warning naming the task.
      if (RESERVED_TASK_SHORTCUT_KEYS.has(shortcut)) {
        continue;
      }
    } else {
      // Auto-assign: first char of the key that is neither already used nor reserved.
      for (const ch of key) {
        if (!used.has(ch) && !RESERVED_TASK_SHORTCUT_KEYS.has(ch)) {
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
