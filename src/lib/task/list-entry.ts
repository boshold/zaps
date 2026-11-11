import type { TaskConfig } from "#src/config/types.js";

import { resolveTaskServiceRequirements } from "./service-requirements.js";

interface TaskListEntry {
  key: string;
  name: string;
  description: string | null;
  services: string[];
  requiredServices: string[];
  autoStart: boolean;
  dependsOn: string[];
}

function buildTaskListEntries(tasks: Record<string, TaskConfig>): TaskListEntry[] {
  return Object.entries(tasks).map(([key, t]) => ({
    key,
    name: t.name,
    description: t.description ?? null,
    services: t.services ?? [],
    requiredServices: resolveTaskServiceRequirements(tasks, key).services,
    autoStart: t.autoStart ?? false,
    dependsOn: t.dependsOn ?? [],
  }));
}

export type { TaskListEntry };
export { buildTaskListEntries };
