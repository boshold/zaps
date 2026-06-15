import type { TaskConfig } from "#src/config/types.js";
import { execCommand, execCommandWithResult } from "#src/lib/exec.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { displayPopup } from "#src/lib/tmux.js";

interface TaskRunnerDeps {
  tasks: Record<string, TaskConfig>;
  statuses: Map<string, ServiceStatus>;
  projectDir: string;
  services?: Record<string, { cwd?: string }>;
  onProgress?: (key: string, result: "success" | "error") => void;
  onLine?: (key: string, line: string) => void;
}

interface ExecuteContext {
  taskCwd: string;
  resolvedEnv: Record<string, string>;
  envSpread: { env?: Record<string, string> };
  emitLine: (line: string) => void;
  serviceCtx: ReturnType<typeof buildServiceContext>;
  projectDir: string;
}

async function executeTask(t: TaskConfig, ctx: ExecuteContext): Promise<void> {
  if (t.run) {
    await t.run({
      async exec(cmd, opts) {
        return execCommandWithResult(cmd, {
          cwd: opts?.cwd ?? ctx.taskCwd,
          env: opts?.env ? { ...ctx.resolvedEnv, ...opts.env } : ctx.resolvedEnv,
          onLine: ctx.emitLine,
        });
      },
      stdout: {
        write(text) {
          const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
          for (const line of lines.split("\n")) {
            ctx.emitLine(line);
          }
        },
      },
      services: ctx.serviceCtx,
      projectDir: ctx.projectDir,
    });
  } else if (t.commands) {
    const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
    const resolvedCommands = commands.map((cmd) =>
      typeof cmd === "function" ? cmd(ctx.serviceCtx) : cmd,
    );

    if (t.popup) {
      const popupCfg = typeof t.popup === "object" ? t.popup : {};
      const joined = resolvedCommands.join(" && ");
      const wrapped = `${joined}; echo; echo 'Press Enter to close...'; read`;
      await displayPopup({
        cwd: ctx.taskCwd,
        command: wrapped,
        title: t.name,
        width: popupCfg.width ?? "80%",
        height: popupCfg.height ?? "80%",
        ...(Object.keys(ctx.resolvedEnv).length > 0 ? { env: ctx.resolvedEnv } : {}),
      });
    } else {
      for (const resolved of resolvedCommands) {
        await execCommand(resolved, {
          cwd: ctx.taskCwd,
          ...ctx.envSpread,
          onLine: ctx.emitLine,
        });
      }
    }
  }
}

export type { TaskRunnerDeps };

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
      if (!(await runTaskWithDeps(dep, deps, visited, results))) {
        return false;
      }
    }
  }

  if (results.get(key) === "success") {
    return true;
  }

  // Resolve env
  const serviceCtx = buildServiceContext(deps.statuses, deps.projectDir, deps.services);
  const resolvedEnv = resolveEnv(t.env, serviceCtx);
  const taskCwd = t.cwd ?? deps.projectDir;
  const envSpread = Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {};
  const emitLine = (line: string) => deps.onLine?.(key, line);

  try {
    await executeTask(t, {
      taskCwd,
      resolvedEnv,
      envSpread,
      emitLine,
      serviceCtx,
      projectDir: deps.projectDir,
    });
  } catch {
    results.set(key, "error");
    deps.onProgress?.(key, "error");
    return false;
  }

  results.set(key, "success");
  deps.onProgress?.(key, "success");
  return true;
}
