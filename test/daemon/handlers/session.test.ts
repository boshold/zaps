import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionHandlers } from "../../../src/daemon/handlers/session.js";
import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import { createMockSession, createMockStore } from "../../_helpers/mock-session.js";
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

describe("session handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("session.attach", () => {
    it("returns attach snapshot", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r1", method: "session.attach", session: session.id };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.id).toBe("r1");
      expect(session.attachSnapshot).toHaveBeenCalled();
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r2", method: "session.attach", session: "unknown" };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });

    it("returns error when session field is missing", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r2b", method: "session.attach" };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("session.detach", () => {
    it("removes socket from subscribers", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      session.subscribers.add(socket);
      const req: IpcRequest = { id: "r3", method: "session.detach", session: session.id };
      const res = await sessionHandlers["session.detach"](req, store, socket as never);
      expect(res.result).toEqual({ detached: true });
      expect(session.subscribers.has(socket)).toBe(false);
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r4", method: "session.detach", session: "bad" };
      const res = await sessionHandlers["session.detach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("subscribe", () => {
    it("adds socket to subscribers", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r5",
        method: "subscribe",
        session: session.id,
        params: { events: [] },
      };
      const res = await sessionHandlers["subscribe"](req, store, socket as never);
      expect(res.result).toEqual({ subscribed: true });
      expect(session.subscribers.has(socket)).toBe(true);
    });

    it("removes subscriber on socket close", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r6",
        method: "subscribe",
        session: session.id,
        params: { events: [] },
      };
      await sessionHandlers["subscribe"](req, store, socket as never);
      expect(session.subscribers.has(socket)).toBe(true);

      socket.emit("close");
      expect(session.subscribers.has(socket)).toBe(false);
    });
  });

  describe("services.list", () => {
    it("returns all statuses", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r7", method: "services.list", session: session.id };
      const res = await sessionHandlers["services.list"](req, store, socket as never);
      expect(session.manager.getAllStatuses).toHaveBeenCalled();
      expect(res.error).toBeUndefined();
    });
  });

  describe("services.details", () => {
    it("returns service details", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r8",
        method: "services.details",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>;
      expect(result["name"]).toBe("api");
    });

    it("returns error for unknown service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r9",
        method: "services.details",
        session: session.id,
        params: { name: "unknown" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      expect(res.error).toContain("Unknown service");
    });
  });

  describe("services.start", () => {
    it("starts service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r10",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.result).toEqual({ started: "api" });
      expect(session.manager.startService).toHaveBeenCalledWith("api");
    });

    it("returns error when start rejects with non-Error", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue("string rejection"); // eslint-disable-line prefer-promise-reject-errors
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r11ne",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.error).toBe("string rejection");
    });

    it("returns error when start fails", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue(new Error("start failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r11",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.error).toBe("start failed");
    });
  });

  describe("services.stop", () => {
    it("stops service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: "api" });
    });

    it("returns error when stop rejects with non-Error", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue("stop string"); // eslint-disable-line prefer-promise-reject-errors
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12ne",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.error).toBe("stop string");
    });

    it("returns error when stop fails", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue(new Error("stop failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12b",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.error).toBe("stop failed");
    });
  });

  describe("services.restart", () => {
    it("restarts service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r13",
        method: "services.restart",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.restart"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: "api" });
      expect(session.manager.restartService).toHaveBeenCalledWith("api");
    });

    it("returns error when restart fails", async () => {
      const session = createMockSession();
      session.manager.restartService.mockRejectedValue(new Error("restart failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r13b",
        method: "services.restart",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.restart"](req, store, socket as never);
      expect(res.error).toBe("restart failed");
    });
  });

  describe("services.startAll", () => {
    it("starts all services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r14",
        method: "services.startAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.result).toEqual({ started: "all" });
      expect(session.manager.startAll).toHaveBeenCalled();
    });

    it("starts named services sequentially", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r15",
        method: "services.startAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.result).toEqual({ started: ["api"] });
      expect(session.manager.startService).toHaveBeenCalledWith("api");
    });

    it("returns error on failure", async () => {
      const session = createMockSession();
      session.manager.startAll.mockRejectedValue(new Error("boom"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r16",
        method: "services.startAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.error).toBe("boom");
    });

    it("returns error when named services start fails", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue(new Error("named start failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r16b",
        method: "services.startAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.error).toBe("named start failed");
    });
  });

  describe("services.details (dependsOn)", () => {
    it("returns dependsOn array when set", async () => {
      const session = createMockSession();
      session.config.project.services = {
        api: { start: "npm dev", dependsOn: ["db"] },
      };
      session.manager.getStatus.mockReturnValue({
        name: "api", state: "ready", ports: [3000], retryCount: 0,
      });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rdo1",
        method: "services.details",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      const result = res.result as Record<string, unknown>;
      expect(result["dependsOn"]).toEqual(["db"]);
    });
  });

  describe("services.details (docker)", () => {
    it("returns hasDocker true when docker is configured", async () => {
      const session = createMockSession();
      session.config.project.services = {
        db: { docker: { service: "postgres" } },
      };
      session.manager.getStatus.mockReturnValue({
        name: "db", state: "ready", ports: [5432], retryCount: 0,
      });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rd1",
        method: "services.details",
        session: session.id,
        params: { name: "db" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      const result = res.result as Record<string, unknown>;
      expect(result["hasDocker"]).toBe(true);
    });
  });

  describe("services.stopAll", () => {
    it("stops all services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r17",
        method: "services.stopAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: "all" });
    });

    it("stops named services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18",
        method: "services.stopAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: ["api"] });
    });

    it("returns error when named services stop fails", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue(new Error("named stop failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18c",
        method: "services.stopAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.error).toBe("named stop failed");
    });

    it("returns error when stopAll fails", async () => {
      const session = createMockSession();
      session.manager.stopAll.mockRejectedValue(new Error("stopAll failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18b",
        method: "services.stopAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.error).toBe("stopAll failed");
    });
  });

  describe("services.restartAll", () => {
    it("restarts all services (stop + start)", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r19",
        method: "services.restartAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: "all" });
      expect(session.manager.stopAll).toHaveBeenCalled();
      expect(session.manager.startAll).toHaveBeenCalled();
    });

    it("restarts named services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20",
        method: "services.restartAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: ["api"] });
    });

    it("returns error when named services restart fails", async () => {
      const session = createMockSession();
      session.manager.restartService.mockRejectedValue(new Error("named restart failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20c",
        method: "services.restartAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.error).toBe("named restart failed");
    });

    it("returns error when restartAll fails", async () => {
      const session = createMockSession();
      session.manager.stopAll.mockRejectedValue(new Error("restartAll failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20b",
        method: "services.restartAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.error).toBe("restartAll failed");
    });
  });

  describe("tasks.list", () => {
    it("returns task list", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        build: { name: "Build", description: "Build the project" },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r21",
        method: "tasks.list",
        session: session.id,
      };
      const res = await sessionHandlers["tasks.list"](req, store, socket as never);
      const result = res.result as { key: string; name: string }[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ key: "build", name: "Build" });
    });

    it("returns empty list when no tasks", async () => {
      const session = createMockSession();
      session.config.project.tasks = undefined;
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r22",
        method: "tasks.list",
        session: session.id,
      };
      const res = await sessionHandlers["tasks.list"](req, store, socket as never);
      expect(res.result).toEqual([]);
    });
  });

  describe("tasks.run", () => {
    it("returns error for unknown task", async () => {
      const session = createMockSession();
      session.config.project.tasks = {};
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r23",
        method: "tasks.run",
        session: session.id,
        params: { key: "missing" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.error).toContain("Unknown task");
    });

    it("runs regular task via runTaskWithDeps", async () => {
      const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
        runTaskWithDeps: ReturnType<typeof vi.fn>;
      };
      runTaskWithDeps.mockResolvedValue(true);

      const session = createMockSession();
      session.config.project.tasks = {
        build: { name: "Build", run: "npm run build" },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r24",
        method: "tasks.run",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
      expect(session.pushTaskRecord).toHaveBeenCalled();
      expect(session.broadcast).toHaveBeenCalled();
    });

    it("runs popup task non-interactively", async () => {
      const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
        execCommand: ReturnType<typeof vi.fn>;
      };
      execCommand.mockResolvedValue(undefined);

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, commands: ["eslint ."] },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
    });

    it("runs popup task with function command", async () => {
      const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
        execCommand: ReturnType<typeof vi.fn>;
      };
      execCommand.mockResolvedValue(undefined);

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, commands: [() => "dynamic-cmd"] },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25b",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
      expect(execCommand).toHaveBeenCalledWith("dynamic-cmd", expect.anything());
    });

    it("returns success: false when popup task throws", async () => {
      const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
        execCommand: ReturnType<typeof vi.fn>;
      };
      execCommand.mockRejectedValue(new Error("exec failed"));

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, commands: ["fail"] },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25c",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: false });
    });

    it("runs task and invokes onLine/onProgress callbacks", async () => {
      const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
        runTaskWithDeps: ReturnType<typeof vi.fn>;
      };
      runTaskWithDeps.mockImplementation(
        async (_key: string, deps: { onLine?: Function; onProgress?: Function }) => {
          deps.onLine?.("build", "output line");
          deps.onProgress?.("build", "success");
          return true;
        },
      );

      const session = createMockSession();
      session.config.project.tasks = {
        build: { name: "Build", commands: "npm run build" },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25f",
        method: "tasks.run",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
      // Verify socket received line and progress events
      expect(socket.write).toHaveBeenCalled();
      const writes = socket.write.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      expect(writes.some((w: { event?: string }) => w.event === "line")).toBe(true);
      expect(writes.some((w: { event?: string }) => w.event === "progress")).toBe(true);
    });

    it("runs popup task with no commands uses runTaskWithDeps", async () => {
      // popup=true but no commands → isPopup=false → falls through to runTaskWithDeps
      const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
        runTaskWithDeps: ReturnType<typeof vi.fn>;
      };
      runTaskWithDeps.mockResolvedValue(false);

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, run: async () => {} },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25e",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: false });
    });

    it("runs popup task with custom cwd", async () => {
      const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
        execCommand: ReturnType<typeof vi.fn>;
      };
      execCommand.mockResolvedValue(undefined);

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, commands: ["eslint ."], cwd: "/custom" },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25cwd",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
      expect(execCommand).toHaveBeenCalledWith(
        "eslint .",
        expect.objectContaining({ cwd: "/custom" }),
      );
    });

    it("runs popup task with env", async () => {
      const { execCommand } = (await import("../../../src/lib/exec.js")) as unknown as {
        execCommand: ReturnType<typeof vi.fn>;
      };
      execCommand.mockResolvedValue(undefined);

      const { resolveEnv } = (await import("../../../src/lib/service/env.js")) as unknown as {
        resolveEnv: ReturnType<typeof vi.fn>;
      };
      resolveEnv.mockReturnValue({ NODE_ENV: "test" });

      const session = createMockSession();
      session.config.project.tasks = {
        lint: { name: "Lint", popup: true, commands: ["eslint ."], env: { NODE_ENV: "test" } },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r25d",
        method: "tasks.run",
        session: session.id,
        params: { key: "lint" },
      };
      const res = await sessionHandlers["tasks.run"](req, store, socket as never);
      expect(res.result).toEqual({ success: true });
      expect(execCommand).toHaveBeenCalledWith(
        "eslint .",
        expect.objectContaining({ env: { NODE_ENV: "test" } }),
      );
    });
  });

  describe("logs.snapshot", () => {
    it("returns log buffer snapshot", async () => {
      const session = createMockSession();
      const buf = session.logBuffers.get("api");
      buf?.append("line1");
      buf?.append("line2");
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r26",
        method: "logs.snapshot",
        session: session.id,
        params: { service: "api" },
      };
      const res = await sessionHandlers["logs.snapshot"](req, store, socket as never);
      expect(res.result).toEqual(["line1", "line2"]);
    });

    it("returns error for unknown service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r27",
        method: "logs.snapshot",
        session: session.id,
        params: { service: "unknown" },
      };
      const res = await sessionHandlers["logs.snapshot"](req, store, socket as never);
      expect(res.error).toContain("Unknown service");
    });
  });
});
