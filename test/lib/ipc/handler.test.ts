import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRequest } from "../../../src/lib/ipc/handler.js";
import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import type { ServiceManager } from "../../../src/lib/service/manager.js";
import { createMockSocket } from "../../_helpers/mock-socket.js";

vi.mock("../../../src/lib/exec.js", () => ({
  execCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/service/env.js", () => ({
  buildServiceContext: vi.fn(() => ({})),
  resolveEnv: vi.fn(() => ({})),
}));

vi.mock("../../../src/lib/task/runner.js", () => ({
  runTaskWithDeps: vi.fn().mockResolvedValue(true),
}));

function createManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
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

describe("handleRequest", () => {
  let manager: ServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createManager();
  });

  afterEach(() => {
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
    expect(result["name"]).toBe("api");
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
    expect(res.result).toEqual({ started: "api" });
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
    expect(res.result).toEqual({ stopped: "api" });
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

  it("handles tasks.run success", async () => {
    const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
      runTaskWithDeps: ReturnType<typeof vi.fn>;
    };
    runTaskWithDeps.mockResolvedValue(true);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { test: { name: "Test", run: "npm test" } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r13", method: "tasks.run", params: { key: "test" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
  });

  it("handles popup task non-interactively", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: ["eslint ."] } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r14", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
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

  it("popup task with no commands returns success: false", async () => {
    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, run: async () => {} } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r16", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    // popup=true + run (no commands) → isPopup=false, uses runTaskWithDeps
    expect(res.result).toEqual({ success: true });
  });

  it("popup task with function commands resolves them", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: [() => "dynamic-lint"] } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r17", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    expect(execCommand).toHaveBeenCalledWith("dynamic-lint", expect.anything());
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
    expect(result["hasDocker"]).toBe(true);
  });

  it("popup task with no commands falls through to runTaskWithDeps", async () => {
    // popup=true + no commands → isPopup=false → uses runTaskWithDeps
    const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
      runTaskWithDeps: ReturnType<typeof vi.fn>;
    };
    runTaskWithDeps.mockResolvedValue(false);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, run: async () => {} } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rnc1", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: false });
  });

  it("popup task with env passes resolved env to execCommand", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const { resolveEnv } = (await import("../../../src/lib/service/env.js")) as unknown as {
      resolveEnv: ReturnType<typeof vi.fn>;
    };
    resolveEnv.mockReturnValue({ NODE_ENV: "test" });

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: ["eslint ."], env: { NODE_ENV: "test" } } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "re1", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    expect(execCommand).toHaveBeenCalledWith(
      "eslint .",
      expect.objectContaining({ env: { NODE_ENV: "test" } }),
    );
  });

  it("tasks.run invokes onLine and onProgress callbacks", async () => {
    const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
      runTaskWithDeps: ReturnType<typeof vi.fn>;
    };
    runTaskWithDeps.mockImplementation(
      async (_key: string, deps: { onLine?: Function; onProgress?: Function }) => {
        deps.onLine?.("test", "output");
        deps.onProgress?.("test", "success");
        return true;
      },
    );

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { test: { name: "Test", commands: "npm test" } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rcb1", method: "tasks.run", params: { key: "test" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    // Verify socket received events
    expect(socket.write).toHaveBeenCalled();
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

  it("popup task with custom cwd uses task cwd", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: ["eslint ."], cwd: "/custom" } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rcwd1", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    expect(execCommand).toHaveBeenCalledWith(
      "eslint .",
      expect.objectContaining({ cwd: "/custom" }),
    );
  });

  it("popup task with single string command (not array)", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: "eslint ." } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "rsc1", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    expect(execCommand).toHaveBeenCalledWith("eslint .", expect.anything());
  });

  it("popup task with empty resolvedEnv omits env from execCommand", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockResolvedValue(undefined);

    const { resolveEnv } = (await import("../../../src/lib/service/env.js")) as unknown as {
      resolveEnv: ReturnType<typeof vi.fn>;
    };
    resolveEnv.mockReturnValue({});

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: ["eslint ."] } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "ree1", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: true });
    const callOpts = execCommand.mock.calls[0][1] as Record<string, unknown>;
    expect(callOpts).not.toHaveProperty("env");
  });

  it("popup task failure returns success: false", async () => {
    const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
      execCommand: ReturnType<typeof vi.fn>;
    };
    execCommand.mockRejectedValue(new Error("exec failed"));

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        tasks: { lint: { name: "Lint", popup: true, commands: ["fail"] } },
      },
    };
    const socket = createMockSocket();
    const req: IpcRequest = { id: "r18", method: "tasks.run", params: { key: "lint" } };
    const res = await handleRequest(req, manager, config as never, socket as never);
    expect(res.result).toEqual({ success: false });
  });
});
