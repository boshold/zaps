import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecResult, ResolvedConfig, TaskConfig, TaskRunContext } from "#src/config/types.js";
import { TaskExecutionService } from "#src/daemon/task-execution.js";
import type { TaskRunOptions } from "#src/daemon/task-execution.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import type { SentraDeps } from "#src/lib/sentra/config.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import { createServiceStatus } from "#src/lib/service/state.js";

import { fakeSentra } from "../_helpers/fake-sentra.js";

function deferred<T>() {
  let settle: (value: T) => void = () => {
    throw new Error("uninitialized");
  };
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function makeConfig(tasks: Record<string, TaskConfig>): ResolvedConfig {
  return {
    project: { name: "tasks", services: {}, tasks },
    configPath: "/project/.zaps.mts",
    projectDir: "/project",
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
}

function makeManager() {
  return {
    startService: vi.fn<ServiceManager["startService"]>().mockResolvedValue({ noop: false }),
    restartService: vi.fn<ServiceManager["restartService"]>().mockResolvedValue(),
    stopService: vi.fn<ServiceManager["stopService"]>().mockResolvedValue({ noop: false }),
    getStatus: vi.fn(() => ({ ...createServiceStatus("api"), state: "ready" as const })),
    getAllStatuses: vi.fn(() => [{ ...createServiceStatus("api"), state: "ready" as const }]),
  };
}

const owners: TaskExecutionService[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(async (owner) => owner.dispose()));
  vi.useRealTimers();
});

function setup(tasks: Record<string, TaskConfig>, sentra?: SentraDeps) {
  const config = makeConfig(tasks);
  const session = {
    id: "session",
    config,
    env: { TOKEN: "accepted" },
    manager: makeManager(),
    deps: { displayPopup: vi.fn().mockResolvedValue(undefined), sentra },
    broadcast: vi.fn(),
  };
  const execute = vi
    .fn<CommandExecutor["execute"]>()
    .mockResolvedValue({ success: true, exitCode: 0, output: [] });
  const owner = new TaskExecutionService(session, () => ({ execute }));
  owners.push(owner);
  const options: TaskRunOptions = { config, cwd: "/project", env: session.env, mode: "background" };
  let stopHook: (hook: () => void | Promise<void>) => Promise<void> = async () => {
    throw new Error("unbound");
  };
  owner.bindManager({
    bindTaskExecution: (_actions, runStopHook) => {
      stopHook = runStopHook;
    },
  });
  return {
    owner,
    session,
    options,
    execute,
    stopHook: async (hook: () => void | Promise<void>) => stopHook(hook),
  };
}

it("registers synchronously before closing, rejects later admission without history or children", async () => {
  const { owner, options, execute } = setup({ build: { name: "Build", commands: "build" } });
  const accepted = owner.run("build", options);
  expect(owner.history).toHaveLength(1);
  const runId = owner.history[0]?.runId;
  expect(runId).toBeTruthy();
  expect(owner.output.size).toBe(1);
  owner.close();
  await expect(owner.run("build", options)).rejects.toThrow("session_closing");
  expect(await accepted).toEqual({ success: false, runId });
  expect(execute).not.toHaveBeenCalled();
  expect(owner.history).toHaveLength(1);
  await owner.dispose();
  owner.close();
  await expect(owner.run("build", options)).rejects.toThrow("session_closing");
});

it("retains captured config/cwd/env and stable output after manager replacement", async () => {
  const entered = deferred<TaskRunContext>();
  const resume = deferred<void>();
  const { owner, session, options, execute } = setup({
    build: {
      name: "Original",
      env: { LOCAL: "task" },
      run: async (ctx) => {
        entered.resolve(ctx);
        await resume.promise;
        expect(process.env.TOKEN).toBe("accepted");
        ctx.stdout.write("after reload\n");
        await ctx.exec("build");
      },
    },
  });
  options.onLine = () => {
    throw new Error("socket closed");
  };
  const pending = owner.run("build", options);
  await entered.promise;
  session.config = makeConfig({});
  session.env.TOKEN = "replaced";
  session.manager = makeManager();
  resume.resolve(undefined);
  const result = await pending;
  expect(result.success).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    "build",
    expect.objectContaining({ cwd: "/project", env: { TOKEN: "accepted", LOCAL: "task" } }),
  );
  expect(owner.output.get(result.runId)?.lines).toEqual(["after reload"]);
  expect(owner.history).toEqual([
    expect.objectContaining({ taskName: "Original", result: "success" }),
  ]);
  expect(session.broadcast.mock.calls.map(([event]) => event.event)).toEqual([
    "task.start",
    "task.complete",
  ]);
});

describe("configuration snapshots before deferred dependencies", () => {
  it("isolates service cwd, task env/definitions and request options", async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const env = { LOCAL: "original" };
    const task: TaskConfig = {
      name: "Original",
      dependsOn: ["wait"],
      env,
      run: async (ctx) => {
        expect(ctx.projectDir).toBe("/project");
        ctx.stdout.write("original sink");
        await ctx.exec(ctx.services.services.api?.cwd ?? "missing");
      },
    };
    const { owner, session, options, execute } = setup({
      wait: {
        name: "Wait",
        run: async () => {
          entered.resolve(undefined);
          await resume.promise;
        },
      },
      root: task,
    });
    const service = { cwd: "/original" };
    options.config.project.services.api = service;
    const originalSink = vi.fn();
    options.onLine = originalSink;
    const pending = owner.run("root", options);
    await entered.promise;
    service.cwd = "/changed";
    env.LOCAL = "changed";
    task.name = "Changed";
    task.dependsOn?.push("missing");
    task.run = async () => {
      throw new Error("changed definition");
    };
    options.cwd = "/changed";
    options.env.TOKEN = "changed";
    options.mode = "configured";
    options.onLine = () => {
      throw new Error("changed sink");
    };
    options.config = makeConfig({});
    session.config.project.services.api = { cwd: "/replaced" };
    resume.resolve(undefined);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "/original",
      expect.objectContaining({
        cwd: "/project",
        env: { TOKEN: "accepted", LOCAL: "original" },
      }),
    );
    expect(originalSink).toHaveBeenCalledWith("original sink");
    expect(owner.history[0]).toMatchObject({ taskName: "Original", result: "success" });
  });

  it("isolates project and task Sentra templates and enabled state", async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const projectSentra = { enabled: true, env: { PROJECT_DSN: "project:{dsn}" } };
    const taskSentra = { env: { TASK_DSN: "task:{dsn}" } };
    const { owner, options, execute } = setup(
      {
        wait: {
          name: "Wait",
          run: async () => {
            entered.resolve(undefined);
            await resume.promise;
          },
        },
        project: { name: "Project", commands: "project", sentra: true },
        target: { name: "Target", commands: "target", sentra: taskSentra },
        root: { name: "Root", dependsOn: ["wait", "project", "target"] },
      },
      fakeSentra(),
    );
    options.config.project.sentra = projectSentra;
    const pending = owner.run("root", options);
    await entered.promise;
    projectSentra.enabled = false;
    projectSentra.env.PROJECT_DSN = "changed";
    taskSentra.env.TASK_DSN = "changed";
    resume.resolve(undefined);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        env: {
          TOKEN: "accepted",
          PROJECT_DSN: "project:http://sentra@127.0.0.1:9000/proj/sess123/project/1",
        },
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({
        env: {
          TOKEN: "accepted",
          TASK_DSN: "task:http://sentra@127.0.0.1:9000/proj/sess123/target/1",
        },
      }),
    );
  });

  it("isolates popup dimensions and command arrays while retaining command/env functions", async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const popup = { width: "60%", height: "40%" };
    const commands: NonNullable<TaskConfig["commands"]> = [
      (ctx) => `echo ${ctx.services.api?.cwd ?? "missing"}`,
    ];
    const { owner, session, options, execute } = setup({
      wait: {
        name: "Wait",
        run: async () => {
          entered.resolve(undefined);
          await resume.promise;
        },
      },
      root: {
        name: "Popup",
        dependsOn: ["wait"],
        popup,
        commands,
        env: (ctx) => ({ SERVICE_CWD: ctx.services.api?.cwd }),
      },
    });
    options.mode = "configured";
    const service = { cwd: "/original" };
    options.config.project.services.api = service;
    const pending = owner.run("root", options);
    await entered.promise;
    popup.width = "90%";
    popup.height = "80%";
    commands.push("changed command");
    service.cwd = "/changed";
    options.mode = "background";
    resume.resolve(undefined);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(session.deps.displayPopup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("echo /original;"),
        width: "60%",
        height: "40%",
        env: { TOKEN: "accepted", SERVICE_CWD: "/original" },
      }),
    );
    expect(session.deps.displayPopup.mock.calls[0]?.[0].command).not.toContain("changed command");
  });
});

it("captured service helpers resolve the current manager and reject starts while closing", async () => {
  const { owner, session } = setup({});
  const helpers = owner.actions;
  const old = session.manager;
  session.manager = makeManager();
  await helpers.startService("api");
  await helpers.restartService("api");
  await helpers.stopService("api");
  expect(helpers.isServiceRunning("api")).toBe(true);
  expect(helpers.isServiceRunning("missing")).toBe(false);
  expect(old.startService).not.toHaveBeenCalled();
  expect(old.stopService).not.toHaveBeenCalled();
  expect(session.manager.startService).toHaveBeenCalledWith("api");
  expect(session.manager.restartService).toHaveBeenCalledWith("api");
  expect(session.manager.stopService).toHaveBeenCalledWith("api");
  owner.close();
  await expect(helpers.startService("api")).rejects.toThrow("session_closing");
  await expect(helpers.restartService("api")).rejects.toThrow("session_closing");
});

it("isolates concurrent captured environments and run IDs", async () => {
  const release = deferred<void>();
  const { owner, options } = setup({
    build: {
      name: "Build",
      run: async (ctx) => {
        await release.promise;
        ctx.stdout.write(process.env.TOKEN ?? "missing");
      },
    },
  });
  const first = owner.run("build", { ...options, env: { TOKEN: "first" } });
  const second = owner.run("build", { ...options, env: { TOKEN: "second" } });
  release.resolve(undefined);
  const [a, b] = await Promise.all([first, second]);
  expect(a.runId).not.toBe(b.runId);
  expect(owner.output.get(a.runId)?.lines).toEqual(["first"]);
  expect(owner.output.get(b.runId)?.lines).toEqual(["second"]);
});

describe("private stop-hook cleanup admission", () => {
  it("admits cleanup tasks, rejects normal captured exec inside cleanup, revokes late cleanup exec", async () => {
    const normalContext = deferred<TaskRunContext>();
    const cleanupContext = deferred<TaskRunContext>();
    const release = deferred<void>();
    const { owner, options, execute, stopHook } = setup({
      normal: {
        name: "Normal",
        run: async (ctx) => {
          normalContext.resolve(ctx);
          await release.promise;
        },
      },
      cleanup: {
        name: "Cleanup",
        run: async (ctx) => {
          cleanupContext.resolve(ctx);
          await ctx.exec("cleanup");
        },
      },
    });
    const normalRun = owner.run("normal", options);
    const normal = await normalContext.promise;
    owner.close();
    await stopHook(async () => {
      await expect(normal.exec("forbidden")).rejects.toThrow("session_closing");
      await owner.actions.runTask("cleanup");
    });
    const cleanup = await cleanupContext.promise;
    expect(Object.keys(cleanup).toSorted()).toEqual([
      "exec",
      "projectDir",
      "services",
      "stdout",
      "url",
    ]);
    await expect(cleanup.exec("late")).rejects.toThrow("session_closing");
    await expect(owner.actions.runTask("cleanup")).rejects.toThrow("session_closing");
    expect(execute.mock.calls.map(([command]) => command)).toEqual(["cleanup"]);
    release.resolve(undefined);
    await normalRun;
  });

  it("expires cleanup authority even while the hook has not returned", async () => {
    vi.useFakeTimers();
    let lateExec: ((command: string) => Promise<ExecResult>) | undefined;
    const { owner, execute, stopHook } = setup({
      cleanup: {
        name: "Cleanup",
        run: async (ctx) => {
          lateExec = ctx.exec;
        },
      },
    });
    owner.close();
    await stopHook(async () => {
      await owner.actions.runTask("cleanup");
      await vi.advanceTimersByTimeAsync(7000);
      await expect(lateExec?.("expired")).rejects.toThrow("session_closing");
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
