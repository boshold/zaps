import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConfig, TaskConfig } from "#src/config/types.js";
import { TaskExecutionService } from "#src/daemon/task-execution.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";

import { handleRequest } from "../../../src/lib/ipc/handler.js";
import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import type { ServiceManager } from "../../../src/lib/service/manager.js";
import { createMockSocket } from "../../_helpers/mock-socket.js";

function createManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    startService: vi.fn().mockResolvedValue({ noop: false }),
    stopService: vi.fn().mockResolvedValue({ noop: false }),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }]),
    getStatus: vi.fn((name: string) => {
      if (name === "api") {
        return { name: "api", state: "ready", ports: [3000], retryCount: 0 };
      }
      throw new Error(`Unknown service: ${name}`);
    }),
  }) as unknown as ServiceManager;
}

const baseConfig = {
  project: {
    name: "test",
    services: { api: { start: "npm dev" } },
    tasks: {},
  },
  configPath: "/test/.zaps.mts",
  projectDir: "/test",
};

const owners: TaskExecutionService[] = [];
function taskFixture(manager: ServiceManager, tasks: Record<string, TaskConfig>) {
  const config: ResolvedConfig = {
    ...baseConfig,
    project: { ...baseConfig.project, tasks },
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
  const execute = vi
    .fn<CommandExecutor["execute"]>()
    .mockImplementation(async (_command, options) => {
      options.onLine?.("output");
      return { success: true, exitCode: 0, output: ["output"] };
    });
  const displayPopup = vi.fn();
  const owner = new TaskExecutionService(
    {
      id: "legacy",
      config,
      env: {},
      manager,
      deps: {},
      broadcast: () => {
        /* Noop */
      },
    },
    () => ({ execute }),
  );
  owners.push(owner);
  return { config, owner, execute, displayPopup };
}

describe("handleRequest", () => {
  let manager: ServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createManager();
  });

  afterEach(async () => {
    await Promise.all(owners.splice(0).map(async (owner) => owner.dispose()));
    vi.restoreAllMocks();
  });

  it("handles ping", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r1", method: "ping" };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res).toEqual({ id: "r1", result: "pong" });
  });

  it("returns error for unknown method", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r2", method: "unknown" };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toContain("Unknown method");
  });

  it("handles services.list", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r3", method: "services.list" };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBeUndefined();
    expect(vi.mocked(manager.getAllStatuses)).toHaveBeenCalled();
  });

  it("handles services.details", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r4", method: "services.details", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBeUndefined();
    const result = res.result as Record<string, unknown>;
    expect(result.name).toBe("api");
  });

  it("handles services.details unknown service", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r5", method: "services.details", params: { name: "bad" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toContain("Unknown service");
  });

  it("handles services.start", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r6", method: "services.start", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.result).toEqual({ started: "api", noop: false });
    expect(vi.mocked(manager.startService)).toHaveBeenCalledWith("api");
  });

  it("handles services.start error", async () => {
    vi.mocked(manager.startService).mockRejectedValue(new Error("fail"));
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r7", method: "services.start", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBe("fail");
  });

  it("handles services.stop", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r8", method: "services.stop", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.result).toEqual({ stopped: "api", noop: false });
  });

  it("handles services.stop error", async () => {
    vi.mocked(manager.stopService).mockRejectedValue(new Error("stop fail"));
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r8b", method: "services.stop", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBe("stop fail");
  });

  it("handles services.restart", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r9", method: "services.restart", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.result).toEqual({ restarted: "api" });
  });

  it("handles services.restart error", async () => {
    vi.mocked(manager.restartService).mockRejectedValue(new Error("restart fail"));
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r9b", method: "services.restart", params: { name: "api" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBe("restart fail");
  });

  it("handles tasks.list", async () => {
    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { build: { name: "Build", description: "Build it" } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r10", method: "tasks.list" };
    const res = await handleRequest(req, manager, config as never, socket as never);
    const result = res.result as { key: string }[];
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("build");
  });

  it("handles tasks.list when no tasks configured", async () => {
    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, tasks: undefined },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r11", method: "tasks.list" };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual([]);
  });

  it("handles tasks.run with unknown task", async () => {
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r12", method: "tasks.run", params: { key: "missing" } };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toContain("Unknown task");
  });

  it("routes popup dependency graphs through the injected background service", async () => {
    const { config, owner, execute, displayPopup } = taskFixture(manager, {
      dep: { name: "Dep", popup: true, commands: "dep" },
      root: {
        name: "Root",
        popup: true,
        dependsOn: ["dep"],
        commands: () => "root",
        env: { LOCAL: "task" },
      },
    });
    const socket = createMockSocket();
    Object.assign(socket, { writable: true, destroyed: false });
    const res = await handleRequest(
      { id: "run", method: "tasks.run", params: { key: "root" } },
      manager,
      config,
      socket as never,
      owner,
    );
    expect(res.result).toMatchObject({ success: true, runId: expect.any(String) });
    expect(execute.mock.calls.map(([command]) => command)).toEqual(["dep", "root"]);
    expect(execute).toHaveBeenLastCalledWith(
      "root",
      expect.objectContaining({ env: { LOCAL: "task" } }),
    );
    expect(displayPopup).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"event":"line"'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"event":"progress"'));
  });

  it("runs callback tasks and propagates prerequisite failure", async () => {
    const callback = vi.fn(async () => {
      /* Noop */
    });
    const { config, owner, execute } = taskFixture(manager, {
      dep: { name: "Dep", popup: true, commands: "fail" },
      root: { name: "Root", popup: true, dependsOn: ["dep"], run: callback },
    });
    execute.mockResolvedValue({ success: false, exitCode: 1, output: [] });
    const request: IpcRequest = { id: "run", method: "tasks.run", params: { key: "root" } };
    const res = await handleRequest(request, manager, config, createMockSocket() as never, owner);
    expect(res.result).toMatchObject({ success: false });
    expect(callback).not.toHaveBeenCalled();
    execute.mockResolvedValue({ success: true, exitCode: 0, output: [] });
    const success = await handleRequest(
      request,
      manager,
      config,
      createMockSocket() as never,
      owner,
    );
    expect(success.result).toMatchObject({ success: true });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("uses the captured task cwd for string commands and settles thrown execution failures", async () => {
    const { config, owner, execute } = taskFixture(manager, {
      root: { name: "Root", popup: true, commands: "root", cwd: "/custom" },
    });
    const request: IpcRequest = { id: "run", method: "tasks.run", params: { key: "root" } };
    const success = await handleRequest(
      request,
      manager,
      config,
      createMockSocket() as never,
      owner,
    );
    expect(success.result).toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({ cwd: "/custom", env: {} }),
    );
    execute.mockRejectedValue(new Error("exec failed"));
    const failed = await handleRequest(
      request,
      manager,
      config,
      createMockSocket() as never,
      owner,
    );
    expect(failed.result).toMatchObject({ success: false });
  });

  it("rejects task execution without a session owner", async () => {
    const { config } = taskFixture(manager, { root: { name: "Root", commands: "root" } });
    const res = await handleRequest(
      { id: "run", method: "tasks.run", params: { key: "root" } },
      manager,
      config,
      createMockSocket() as never,
    );
    expect(res.error).toBe("Task execution requires a session");
  });

  it("catches handler errors", async () => {
    vi.mocked(manager.getAllStatuses).mockImplementation(() => {
      throw new Error("unexpected");
    });
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r15", method: "services.list" };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBe("unexpected");
  });

  it("services.details returns hasDocker true when docker config exists", async () => {
    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        services: { api: { start: "npm dev", docker: { service: "api" } } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rd1", method: "services.details", params: { name: "api" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    const result = res.result as Record<string, unknown>;
    expect(result.hasDocker).toBe(true);
  });

  it("catches non-Error objects in handleRequest", async () => {
    vi.mocked(manager.getAllStatuses).mockImplementation(() => {
      throw "string error"; // eslint-disable-line no-throw-literal
    });
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rne1", method: "services.list" };
    const res = await handleRequest(req, manager, baseConfig as never, socket as never);
    expect(res.error).toBe("string error");
  });
});
