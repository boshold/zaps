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

vi.mock("../../../src/lib/tmux.js", () => ({
  newWindow: vi.fn().mockResolvedValue("%win"),
  splitPane: vi.fn().mockResolvedValue("%split"),
  sendKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/task/run-in-pane.js", () => ({
  buildPaneCommand: vi.fn(() => "BUILT_CMD"),
  awaitPaneOutcome: vi.fn().mockResolvedValue("success"),
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

  describe("session.reload", () => {
    it("calls reload on session", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload", method: "session.reload", session: session.id };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.result).toEqual({ reloaded: true });
      expect(session.reload).toHaveBeenCalled();
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload2", method: "session.reload", session: "bad" };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });

    it("returns error when reload fails", async () => {
      const session = createMockSession();
      session.reload = vi.fn().mockRejectedValue(new Error("Config invalid"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload3", method: "session.reload", session: session.id };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.error).toBe("Config invalid");
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
      const res = await sessionHandlers.subscribe(req, store, socket as never);
      expect(res.result).toEqual({ subscribed: true });
      expect(session.subscribers.has(socket)).toBe(true);
    });

    it("does not stack a close listener per subscribe call (D7)", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r6",
        method: "subscribe",
        session: session.id,
        params: { events: [] },
      };

      // Subscribing many times on one connection must not register any socket
      // Close listeners — server-level cleanup owns removal, not the handler.
      for (let i = 0; i < 15; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential subscribes on one socket
        await sessionHandlers.subscribe(req, store, socket as never);
      }

      expect(socket.listenerCount("close")).toBe(0);
      expect(session.subscribers.has(socket)).toBe(true);
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
      expect(result.name).toBe("api");
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
      expect(res.result).toEqual({ started: "api", noop: false });
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
      expect(res.result).toEqual({ stopped: "api", noop: false });
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
        name: "api",
        state: "ready",
        ports: [3000],
        retryCount: 0,
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
      expect(result.dependsOn).toEqual(["db"]);
    });
  });

  describe("services.details (docker)", () => {
    it("returns hasDocker true when docker is configured", async () => {
      const session = createMockSession();
      session.config.project.services = {
        db: { docker: { service: "postgres" } },
      };
      session.manager.getStatus.mockReturnValue({
        name: "db",
        state: "ready",
        ports: [5432],
        retryCount: 0,
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
      expect(result.hasDocker).toBe(true);
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
      const result = res.result as { success: boolean; runId: string };
      expect(result.success).toBe(true);
      // The run's id is returned for correlation, and threaded into the records.
      expect(result.runId).toEqual(expect.any(String));
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId: result.runId, result: "running", mode: "background" }),
      );
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId: result.runId, result: "success" }),
      );
      expect(session.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "task.start",
          data: expect.objectContaining({ runId: result.runId }),
        }),
      );
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
      expect(res.result).toMatchObject({ success: true });
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
      expect(res.result).toMatchObject({ success: true });
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
      expect(res.result).toMatchObject({ success: false });
    });

    it("runs task and invokes onLine/onProgress callbacks", async () => {
      const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
        runTaskWithDeps: ReturnType<typeof vi.fn>;
      };
      runTaskWithDeps.mockImplementation(
        (_key: string, deps: { onLine?: Function; onProgress?: Function }) => {
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
      expect(res.result).toMatchObject({ success: true });
      // Verify socket received line and progress events
      expect(socket.write).toHaveBeenCalled();
      const writes = socket.write.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      expect(writes.some((w: { event?: string }) => w.event === "line")).toBe(true);
      expect(writes.some((w: { event?: string }) => w.event === "progress")).toBe(true);
    });

    it("runs popup task with no commands uses runTaskWithDeps", async () => {
      // Popup=true but no commands → isPopup=false → falls through to runTaskWithDeps
      const { runTaskWithDeps } = (await import("../../../src/lib/task/runner.js")) as {
        runTaskWithDeps: ReturnType<typeof vi.fn>;
      };
      runTaskWithDeps.mockResolvedValue(false);

      const session = createMockSession();
      session.config.project.tasks = {
        lint: {
          name: "Lint",
          popup: true,
          run: async () => {
            /* Noop */
          },
        },
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
      expect(res.result).toMatchObject({ success: false });
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
      expect(res.result).toMatchObject({ success: true });
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
      expect(res.result).toMatchObject({ success: true });
      expect(execCommand).toHaveBeenCalledWith(
        "eslint .",
        expect.objectContaining({ env: { NODE_ENV: "test" } }),
      );
    });
  });

  describe("tasks.runInPane", () => {
    it("returns unknown_task for a missing key", async () => {
      const session = createMockSession();
      session.config.project.tasks = {};
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp1",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "missing" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toBe("unknown_task");
    });

    it("creates a new window by default and returns runId + paneId", async () => {
      const { newWindow, splitPane, sendKeys } =
        (await import("../../../src/lib/tmux.js")) as unknown as {
          newWindow: ReturnType<typeof vi.fn>;
          splitPane: ReturnType<typeof vi.fn>;
          sendKeys: ReturnType<typeof vi.fn>;
        };

      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp2",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      const result = res.result as { runId: string; paneId: string };
      expect(result.runId).toEqual(expect.any(String));
      expect(result.paneId).toBe("%win");
      expect(newWindow).toHaveBeenCalledWith("test-tmux");
      expect(splitPane).not.toHaveBeenCalled();
      // The launched command is the one buildPaneCommand produced, sent to the pane.
      expect(sendKeys).toHaveBeenCalledWith("%win", "BUILT_CMD");
      // Stores runId → paneId so the pane can later be addressed (T04).
      expect(session.panesByRun.get(result.runId)).toBe("%win");
      // Records + broadcasts task.start with mode:"pane".
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId: result.runId, result: "running", mode: "pane" }),
      );
      expect(session.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "task.start",
          data: expect.objectContaining({ runId: result.runId }),
        }),
      );
    });

    it("splits a pane when target=pane", async () => {
      const { splitPane } = (await import("../../../src/lib/tmux.js")) as unknown as {
        splitPane: ReturnType<typeof vi.fn>;
      };

      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp3",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build", target: "pane" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect((res.result as { paneId: string }).paneId).toBe("%split");
      // Splits off the reserved TUI pane.
      expect(splitPane).toHaveBeenCalledWith("%0", "v");
    });

    it("returns tmux_failed when pane creation fails", async () => {
      const { newWindow } = (await import("../../../src/lib/tmux.js")) as unknown as {
        newWindow: ReturnType<typeof vi.fn>;
      };
      newWindow.mockRejectedValueOnce(new Error("tmux down"));

      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp4",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toBe("tmux_failed");
    });

    it("errors when the task has no shell commands", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        custom: {
          name: "Custom",
          run: async () => {
            /* Noop */
          },
        },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp5",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "custom" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toContain("no shell commands");
    });

    it("broadcasts task.complete once the pane run finishes", async () => {
      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp6",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      const { runId } = res.result as { runId: string };

      // Completion is detected asynchronously (awaitPaneOutcome → success).
      await vi.waitFor(() => {
        expect(session.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "task.complete",
            data: expect.objectContaining({ runId, result: "success" }),
          }),
        );
      });
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId, result: "success", mode: "pane" }),
      );
    });
  });

  describe("tasks.output", () => {
    it("returns the retained buffer for a known runId", async () => {
      const session = createMockSession();
      session.taskOutput.start("run_x", "migrate", 1000);
      session.taskOutput.appendLines("run_x", ["line a", "line b"]);
      session.taskOutput.finish("run_x", "success", 2000);
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro1",
        method: "tasks.output",
        session: session.id,
        params: { runId: "run_x" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({
        runId: "run_x",
        taskKey: "migrate",
        result: "success",
        lines: ["line a", "line b"],
        startedAt: 1000,
        endedAt: 2000,
      });
    });

    it("returns not_found for an unknown/evicted runId", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro2",
        method: "tasks.output",
        session: session.id,
        params: { runId: "gone" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toBe("not_found");
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro3",
        method: "tasks.output",
        session: "unknown",
        params: { runId: "run_x" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toContain("Unknown session");
    });
  });

  describe("exec-service.resolve", () => {
    it("returns exec info and deletes it", async () => {
      const session = createMockSession();
      session.execInfo.set("dev", { command: "pnpm dev", cwd: "/test", env: { DB: "x" } });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re1",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.result).toEqual({ command: "pnpm dev", cwd: "/test", env: { DB: "x" } });
      expect(session.execInfo.has("dev")).toBe(false);
    });

    it("returns error when no exec info exists", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re2",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.error).toContain("No exec info");
    });

    it("returns error for second resolve (one-time delete)", async () => {
      const session = createMockSession();
      session.execInfo.set("dev", { command: "pnpm dev", cwd: "/test", env: {} });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re3",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      const res2 = await sessionHandlers["exec-service.resolve"](
        { ...req, id: "re4" },
        store,
        socket as never,
      );
      expect(res2.error).toContain("No exec info");
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re5",
        method: "exec-service.resolve",
        session: "unknown",
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("exec-service.exited", () => {
    it("calls handleExecExited with correct args", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx1",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 1, signal: "SIGTERM" },
      };
      const res = await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(res.result).toEqual({ ok: true });
      expect(session.manager.handleExecExited).toHaveBeenCalledWith("dev", 1, "SIGTERM", undefined);
    });

    it("defaults null signal when omitted", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx2",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 0 },
      };
      await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(session.manager.handleExecExited).toHaveBeenCalledWith("dev", 0, null, undefined);
    });

    it("forwards spawnError to handleExecExited", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx3",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 127, signal: null, spawnError: "spawn cwd ENOENT" },
      };
      await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(session.manager.handleExecExited).toHaveBeenCalledWith(
        "dev",
        127,
        null,
        "spawn cwd ENOENT",
      );
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx3",
        method: "exec-service.exited",
        session: "unknown",
        params: { service: "dev", code: 1 },
      };
      const res = await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
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
