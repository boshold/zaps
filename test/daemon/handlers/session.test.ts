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
