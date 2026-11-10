import { AsyncLocalStorage } from "node:async_hooks";

import type { TaskRunRecord } from "#src/components/TaskRunRecord.js";
import type {
  LibraryActions,
  ResolvedConfig,
  SentraConfig,
  TaskConfig,
} from "#src/config/types.js";
import { OwnedCommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import { ProcessAdmission, ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type { ProcessAuthority } from "#src/lib/backend/runtime/process-runner.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { runWithEnvironment } from "#src/lib/request-context.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import { newRunId } from "#src/lib/task/run-id.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

import { TaskOutputStore } from "./task-output-store.js";

const MAX_TASK_HISTORY = 50;
const CLEANUP_SCOPE_MS = 7000;

interface TaskSession {
  id: string;
  config: ResolvedConfig;
  env: Record<string, string>;
  manager: Pick<
    ServiceManager,
    "startService" | "restartService" | "stopService" | "getAllStatuses"
  >;
  deps: Pick<ServiceManagerDeps, "displayPopup" | "sentra">;
  broadcast(event: DaemonEvent): void;
}

interface TaskRunOptions {
  config: ResolvedConfig;
  cwd: string;
  env: Record<string, string>;
  mode: "background" | "configured";
  onLine?: (line: string) => void;
  onProgress?: (key: string, result: "success" | "error") => void;
}

interface CapturedTaskContext extends Omit<TaskRunOptions, "config"> {
  tasks: Record<string, TaskConfig>;
  services: Record<string, { cwd?: string }>;
  sentraConfig?: SentraConfig;
}

function captureContext(options: TaskRunOptions): CapturedTaskContext {
  const { project } = options.config;
  return {
    cwd: options.cwd,
    env: { ...options.env },
    mode: options.mode,
    onLine: options.onLine,
    onProgress: options.onProgress,
    tasks: Object.fromEntries(
      Object.entries(project.tasks ?? {}).map(([key, task]) => [
        key,
        {
          ...task,
          dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
          commands: Array.isArray(task.commands) ? [...task.commands] : task.commands,
          env: typeof task.env === "object" ? { ...task.env } : task.env,
          popup: typeof task.popup === "object" ? { ...task.popup } : task.popup,
          sentra: typeof task.sentra === "object" ? { env: { ...task.sentra.env } } : task.sentra,
        },
      ]),
    ),
    services: Object.fromEntries(
      Object.entries(project.services).map(([name, service]) => [name, { cwd: service.cwd }]),
    ),
    sentraConfig: project.sentra
      ? { ...project.sentra, env: { ...project.sentra.env } }
      : undefined,
  };
}

interface AcceptedRun {
  runId: string;
  key: string;
  name: string;
  context: CapturedTaskContext;
}

class TaskExecutionService {
  public readonly history: TaskRunRecord[] = [];
  public readonly output = new TaskOutputStore();
  public readonly actions: LibraryActions;
  private readonly admission = new ProcessAdmission();
  private readonly cleanupContext = new AsyncLocalStorage<ProcessAuthority>();
  private readonly runner: ProcessRunner;
  private readonly activeRuns = new Map<string, AcceptedRun>();
  private state: "active" | "closing" | "disposed" = "active";

  private readonly session: TaskSession;
  private readonly executorFactory?: (
    runner: ProcessRunner,
    authority: ProcessAuthority,
  ) => CommandExecutor;

  public constructor(
    session: TaskSession,
    executorFactory?: (runner: ProcessRunner, authority: ProcessAuthority) => CommandExecutor,
  ) {
    this.session = session;
    this.executorFactory = executorFactory;
    this.runner = new ProcessRunner({
      admission: this.admission,
      onLines: () => {
        /* CommandExecutor owns output capture. */
      },
      onExit: () => {
        /* CommandExecutor owns completion. */
      },
    });
    this.actions = {
      runTask: async (key) => {
        const result = await this.run(key, {
          config: this.session.config,
          cwd: this.session.config.projectDir,
          env: this.session.env,
          mode: "configured",
        });
        if (!result.success) {
          throw new Error(`Task '${key}' failed`);
        }
      },
      startService: async (name) => {
        this.assertNormalAdmission();
        await this.session.manager.startService(name);
      },
      restartService: async (name) => {
        this.assertNormalAdmission();
        await this.session.manager.restartService(name);
      },
      stopService: async (name) => {
        await this.session.manager.stopService(name);
      },
      isServiceRunning: (name) =>
        this.session.manager
          .getAllStatuses()
          .some((status) => status.name === name && status.state === "ready"),
    };
  }

  public bindManager(manager: Pick<ServiceManager, "bindTaskExecution">): void {
    // Legacy mock managers lack composition hooks until P06-T04.
    manager.bindTaskExecution?.(this.actions, async (hook) => this.withStopHook(hook));
  }

  private assertNormalAdmission(): void {
    this.assertAdmission(this.admission.normal);
  }

  private assertAdmission(authority: ProcessAuthority): void {
    if (!this.admission.allows(authority)) {
      throw new Error("session_closing");
    }
  }

  public close(): void {
    if (this.state === "active") {
      this.state = "closing";
      this.admission.close();
    }
  }

  public async dispose(): Promise<void> {
    this.close();
    this.state = "disposed";
    this.admission.dispose();
    await this.runner.dispose();
  }

  private async withStopHook(hook: () => void | Promise<void>): Promise<void> {
    const scope = this.admission.createCleanupScope(Date.now() + CLEANUP_SCOPE_MS);
    try {
      await this.cleanupContext.run(scope.authority, hook);
    } finally {
      scope.revoke();
    }
  }

  public pushRecord(record: TaskRunRecord): void {
    const index = this.history.findIndex(
      (entry) =>
        entry.runId === record.runId &&
        entry.taskKey === record.taskKey &&
        entry.result === "running",
    );
    if (record.result !== "running" && index !== -1) {
      this.history[index] = record;
    } else {
      this.history.unshift(record);
      this.history.length = Math.min(this.history.length, MAX_TASK_HISTORY);
    }
  }

  public async run(
    key: string,
    options: TaskRunOptions,
  ): Promise<{ success: boolean; runId: string }> {
    const authority = this.cleanupContext.getStore() ?? this.admission.normal;
    this.assertAdmission(authority);
    const context = captureContext(options);
    const { tasks } = context;
    const task = tasks[key];
    if (!task) {
      throw new Error(`Unknown task: ${key}`);
    }
    const run: AcceptedRun = { runId: newRunId(), key, name: task.name, context };
    this.activeRuns.set(run.runId, run);
    this.output.start(run.runId, key, Date.now());
    this.pushRecord({
      runId: run.runId,
      taskKey: key,
      taskName: run.name,
      result: "running",
      timestamp: Date.now(),
      mode: "background",
    });
    this.session.broadcast({
      session: this.session.id,
      event: "task.start",
      data: { key, name: run.name, runId: run.runId },
    });
    const executor =
      this.executorFactory?.(this.runner, authority) ??
      new OwnedCommandExecutor(this.runner, authority);
    const commandExecutor: CommandExecutor = {
      execute: async (command, commandOptions) => {
        this.assertAdmission(authority);
        return executor.execute(command, commandOptions);
      },
    };
    let success = false;
    try {
      success = await runWithEnvironment(context.env, async () =>
        runTaskWithDeps(
          key,
          {
            tasks,
            statuses: new Map(
              this.session.manager
                .getAllStatuses()
                .map((status) => [status.name, { ...status, ports: [...status.ports] }]),
            ),
            projectDir: context.cwd,
            services: context.services,
            env: context.env,
            commandExecutor,
            mode: context.mode,
            assertAdmission: () => this.assertAdmission(authority),
            tmux: { displayPopup: this.session.deps.displayPopup },
            sentra: this.session.deps.sentra,
            sentraConfig: context.sentraConfig,
            onLine: (_key, line) => {
              this.output.append(run.runId, line);
              try {
                context.onLine?.(line);
              } catch {
                /* Request sinks may disconnect. */
              }
            },
            onProgress: (taskKey, result) => {
              try {
                context.onProgress?.(taskKey, result);
              } catch {
                /* Request sinks may disconnect. */
              }
            },
          },
          new Set(),
          new Map(),
        ),
      );
    } finally {
      const result = success ? "success" : "error";
      this.output.finish(run.runId, result, Date.now());
      this.pushRecord({
        runId: run.runId,
        taskKey: key,
        taskName: run.name,
        result,
        timestamp: Date.now(),
      });
      this.activeRuns.delete(run.runId);
      this.session.broadcast({
        session: this.session.id,
        event: "task.complete",
        data: { key, name: run.name, result, runId: run.runId },
      });
    }
    return { success, runId: run.runId };
  }
}

export { TaskExecutionService };
export type { TaskRunOptions };
