import type { TaskConfig } from "#src/config/types.js";

export interface TaskServiceRequirements {
  services: string[];
  autoStartServices: string[];
}

export function resolveTaskServiceRequirements(
  tasks: Record<string, TaskConfig>,
  key: string,
): TaskServiceRequirements {
  const services = new Set<string>();
  const autoStart = new Set<string>();
  const visited = new Set<string>();

  function visit(taskKey: string): void {
    if (visited.has(taskKey)) {
      return;
    }
    visited.add(taskKey);
    const task = tasks[taskKey];
    if (!task) {
      throw new Error(`Unknown task: ${taskKey}`);
    }
    for (const dep of task.dependsOn ?? []) {
      visit(dep);
    }
    for (const svc of task.services ?? []) {
      services.add(svc);
      if (task.autoStart) {
        autoStart.add(svc);
      }
    }
  }

  visit(key);
  const ordered = [...services];
  return { services: ordered, autoStartServices: ordered.filter((s) => autoStart.has(s)) };
}
