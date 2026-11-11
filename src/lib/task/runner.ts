import type { ExecResult, SentraConfig, TaskConfig } from "#src/config/types.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import type { ConfiguredTaskOutcome } from "#src/lib/backend/types.js";
import { sentraEnvFor } from "#src/lib/sentra/config.js";
import type { SentraDeps } from "#src/lib/sentra/config.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

type TaskRunMode = "background" | "configured";

interface TaskPopupRequest {
  key: string;
  title: string;
  commands: string[];
  cwd: string;
  env: Record<string, string>;
  width: string;
  height: string;
}

interface TaskPresentation {
  popup(request: TaskPopupRequest): Promise<ConfiguredTaskOutcome>;
}

interface TaskRunnerDeps {
  tasks: Record<string, TaskConfig>;
  assertAdmission?: () => void;
  commandExecutor: CommandExecutor;
  env?: Record<string, string>;
  mode: TaskRunMode;
  statuses: Map<string, ServiceStatus>;
  projectDir: string;
  services?: Record<string, { cwd?: string }>;
  onProgress?: (key: string, result: "success" | "error") => void;
  onLine?: (key: string, line: string) => void;
  presentation?: TaskPresentation;
  /** Sentra env injection for opted-in tasks. */
  sentra?: SentraDeps;
  sentraConfig?: SentraConfig;
}

interface ExecuteContext {
  taskCwd: string;
  commandExecutor: CommandExecutor;
  mode: TaskRunMode;
  resolvedEnv: Record<string, string>;
  emitLine: (line: string) => void;
  serviceCtx: ReturnType<typeof buildServiceContext>;
  projectDir: string;
  key: string;
  presentation?: TaskPresentation;
}

async function executeTask(t: TaskConfig, ctx: ExecuteContext): Promise<void> {
  const execute = async (commands: string[], cwd = ctx.taskCwd, env = ctx.resolvedEnv) => {
    if (t.popup && ctx.mode === "configured" && ctx.presentation) {
      const popupCfg = typeof t.popup === "object" ? t.popup : {};
      const outcome = await ctx.presentation.popup({
        key: ctx.key,
        cwd,
        commands,
        title: t.name,
        width: popupCfg.width ?? "80%",
        height: popupCfg.height ?? "80%",
        env,
      });
      if (outcome.kind === "completed") {
        return { success: outcome.exitCode === 0, exitCode: outcome.exitCode, output: [] };
      }
    }
    let result: ExecResult = { success: true, exitCode: 0, output: [] };
    for (const command of commands) {
      result = await ctx.commandExecutor.execute(command, { cwd, env, onLine: ctx.emitLine });
      if (!result.success) {
        break;
      }
    }
    return result;
  };
  if (t.run) {
    await t.run({
      exec: async (cmd, opts) =>
        execute(
          [cmd],
          opts?.cwd ?? ctx.taskCwd,
          opts?.env ? { ...ctx.resolvedEnv, ...opts.env } : ctx.resolvedEnv,
        ),
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
      url: ctx.serviceCtx.url,
    });
  } else if (t.commands) {
    const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
    const result = await execute(
      commands.map((cmd) => (typeof cmd === "function" ? cmd(ctx.serviceCtx) : cmd)),
    );
    if (!result.success) {
      throw new Error(`Command failed with code ${result.exitCode}`);
    }
  }
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
  const sentraEnv = await sentraEnvFor(deps.sentra, deps.sentraConfig, t.sentra, key);
  const resolvedEnv = { ...deps.env, ...sentraEnv, ...resolveEnv(t.env, serviceCtx) };
  const taskCwd = t.cwd ?? deps.projectDir;
  const emitLine = (line: string) => deps.onLine?.(key, line);

  try {
    deps.assertAdmission?.();
    await executeTask(t, {
      taskCwd,
      commandExecutor: deps.commandExecutor,
      mode: deps.mode,
      resolvedEnv,
      emitLine,
      serviceCtx,
      projectDir: deps.projectDir,
      key,
      presentation: deps.presentation,
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

export type { TaskRunnerDeps, TaskRunMode, TaskPopupRequest, TaskPresentation };
