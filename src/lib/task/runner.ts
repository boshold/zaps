import type { SentraConfig, TaskConfig } from "#src/config/types.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import { execCommand, execCommandWithResult } from "#src/lib/exec.js";
import { sentraEnvFor } from "#src/lib/sentra/config.js";
import type { SentraDeps } from "#src/lib/sentra/config.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { defaultTmux } from "#src/lib/tmux-default.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

/** The tmux command a popup task issues. */
type RunnerTmux = Pick<TmuxHandle, "displayPopup">;

interface TaskRunnerDeps {
  tasks: Record<string, TaskConfig>;
  assertAdmission?: () => void;
  /** Legacy direct callers migrate in P03-T02; standalone fixtures in P06-T04. */
  commandExecutor?: CommandExecutor;
  env?: Record<string, string>;
  mode?: "background" | "configured";
  statuses: Map<string, ServiceStatus>;
  projectDir: string;
  services?: Record<string, { cwd?: string }>;
  onProgress?: (key: string, result: "success" | "error") => void;
  onLine?: (key: string, line: string) => void;
  /** Tmux surface for popup tasks; defaults to the env-based handle. */
  tmux?: RunnerTmux;
  /** Sentra env injection for opted-in tasks. */
  sentra?: SentraDeps;
  sentraConfig?: SentraConfig;
}

interface ExecuteContext {
  taskCwd: string;
  commandExecutor?: CommandExecutor;
  mode?: "background" | "configured";
  resolvedEnv: Record<string, string>;
  envSpread: { env?: Record<string, string> };
  emitLine: (line: string) => void;
  serviceCtx: ReturnType<typeof buildServiceContext>;
  projectDir: string;
  tmux: RunnerTmux;
}

async function executeTask(t: TaskConfig, ctx: ExecuteContext): Promise<void> {
  if (t.run) {
    await t.run({
      async exec(cmd, opts) {
        const execute =
          ctx.commandExecutor?.execute.bind(ctx.commandExecutor) ?? execCommandWithResult;
        return execute(cmd, {
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
      url: ctx.serviceCtx.url,
    });
  } else if (t.commands) {
    const commands = Array.isArray(t.commands) ? t.commands : [t.commands];
    const resolvedCommands = commands.map((cmd) =>
      typeof cmd === "function" ? cmd(ctx.serviceCtx) : cmd,
    );

    if (t.popup && ctx.mode !== "background") {
      const popupCfg = typeof t.popup === "object" ? t.popup : {};
      const joined = resolvedCommands.join(" && ");
      const wrapped = `${joined}; echo; echo 'Press Enter to close...'; read`;
      await ctx.tmux.displayPopup({
        cwd: ctx.taskCwd,
        command: wrapped,
        title: t.name,
        width: popupCfg.width ?? "80%",
        height: popupCfg.height ?? "80%",
        ...(Object.keys(ctx.resolvedEnv).length > 0 ? { env: ctx.resolvedEnv } : {}),
      });
    } else {
      for (const resolved of resolvedCommands) {
        if (ctx.commandExecutor) {
          const result = await ctx.commandExecutor.execute(resolved, {
            cwd: ctx.taskCwd,
            env: ctx.resolvedEnv,
            onLine: ctx.emitLine,
          });
          if (!result.success) {
            throw new Error(`Command failed with code ${result.exitCode}`);
          }
        } else {
          await execCommand(resolved, {
            cwd: ctx.taskCwd,
            ...ctx.envSpread,
            onLine: ctx.emitLine,
          });
        }
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
  const sentraEnv = await sentraEnvFor(deps.sentra, deps.sentraConfig, t.sentra, key);
  const resolvedEnv = { ...deps.env, ...sentraEnv, ...resolveEnv(t.env, serviceCtx) };
  const taskCwd = t.cwd ?? deps.projectDir;
  const envSpread = Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {};
  const emitLine = (line: string) => deps.onLine?.(key, line);

  try {
    deps.assertAdmission?.();
    await executeTask(t, {
      taskCwd,
      commandExecutor: deps.commandExecutor,
      mode: deps.mode,
      resolvedEnv,
      envSpread,
      emitLine,
      serviceCtx,
      projectDir: deps.projectDir,
      tmux: deps.tmux ?? defaultTmux,
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
