import type { TaskConfig } from "#src/config/types.js";
import { execCommand } from "#src/lib/exec.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

export interface TaskRunnerDeps {
  tasks: Record<string, TaskConfig>;
  statuses: Map<string, ServiceStatus>;
  projectDir: string;
  onProgress?: (key: string, result: "success" | "error") => void;
  onLine?: (key: string, line: string) => void;
}

export async function runTaskWithDeps(
  key: string,
  deps: TaskRunnerDeps,
  visited: Set<string>,
  results: Map<string, "success" | "error">,
): Promise<boolean> {
  if (visited.has(key)) {
    return results.get(key) === "success";
  }
  visited.add(key);

  const t = deps.tasks[key];
  if (!t) {
    throw new Error(`Unknown task dependency: ${key}`);
  }

  // Run deps first
  if (t.dependsOn) {
    for (const dep of t.dependsOn) {
      // eslint-disable-next-line no-await-in-loop -- Sequential dependency execution
      if (!(await runTaskWithDeps(dep, deps, visited, results))) {
        return false;
      }
    }
  }

  if (results.get(key) === "success") {
    return true;
  }

  // Resolve env
  const ctx = buildServiceContext(deps.statuses, deps.projectDir);
  const resolvedEnv = resolveEnv(t.env, ctx);

  // Run commands
  const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
  for (const cmd of commands) {
    const resolved = typeof cmd === "function" ? cmd() : cmd;
    try {
      // eslint-disable-next-line no-await-in-loop -- Sequential command execution
      await execCommand(resolved, {
        cwd: t.cwd ?? deps.projectDir,
        ...(Object.keys(resolvedEnv).length > 0 && { env: resolvedEnv }),
        onLine: (line) => {
          deps.onLine?.(key, line);
        },
      });
    } catch {
      results.set(key, "error");
      deps.onProgress?.(key, "error");
      return false;
    }
  }
  results.set(key, "success");
  deps.onProgress?.(key, "success");
  return true;
}
