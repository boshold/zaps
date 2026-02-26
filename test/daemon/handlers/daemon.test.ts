import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemonHandlers } from "../../../src/daemon/handlers/daemon.js";
import { createMockSession, createMockStore } from "../../_helpers/mock-session.js";

describe("daemon handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("daemon.ping", () => {
    it("returns pong", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r1", method: "daemon.ping" };
      const res = await daemonHandlers["daemon.ping"](req, store);
      expect(res).toEqual({ id: "r1", result: "pong" });
    });
  });

  describe("daemon.status", () => {
    it("returns pid and session list", async () => {
      const session = createMockSession({ id: "s1", name: "my-proj" });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r2", method: "daemon.status" };
      const res = await daemonHandlers["daemon.status"](req, store);
      expect(res.id).toBe("r2");
      const result = res.result as { pid: number; sessions: unknown[] };
      expect(result.pid).toBe(process.pid);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({ id: "s1", name: "my-proj" });
    });

    it("returns empty sessions when none exist", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r3", method: "daemon.status" };
      const res = await daemonHandlers["daemon.status"](req, store);
      const result = res.result as { sessions: unknown[] };
      expect(result.sessions).toEqual([]);
    });
  });

  describe("daemon.shutdown", () => {
    it("returns shuttingDown and schedules exit", async () => {
      vi.useFakeTimers();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      const store = createMockStore();
      const req: IpcRequest = { id: "r4", method: "daemon.shutdown" };
      const res = await daemonHandlers["daemon.shutdown"](req, store);
      expect(res).toEqual({ id: "r4", result: { shuttingDown: true } });

      vi.advanceTimersByTime(200);
      expect(exitSpy).toHaveBeenCalledWith(0);

      vi.useRealTimers();
      exitSpy.mockRestore();
    });
  });

  describe("session.list", () => {
    it("returns session info", async () => {
      const session = createMockSession({
        id: "s1",
        name: "proj",
        configPath: "/a/.zaps.mts",
        projectDir: "/a",
      });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r5", method: "session.list" };
      const res = await daemonHandlers["session.list"](req, store);
      const result = res.result as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "s1",
        name: "proj",
        configPath: "/a/.zaps.mts",
        projectDir: "/a",
      });
    });
  });

  describe("session.create", () => {
    it("creates session via store", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const req: IpcRequest = {
        id: "r6",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "main",
          originPane: "%0",
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.result).toMatchObject({
        id: session.id,
        name: session.name,
      });
    });

    it("returns error when configPath missing", async () => {
      const store = createMockStore();
      const req: IpcRequest = {
        id: "r7",
        method: "session.create",
        params: {},
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("configPath required");
    });

    it("returns error when store.create throws", async () => {
      const store = createMockStore();
      vi.mocked(store.create).mockRejectedValue(new Error("load failed"));
      const req: IpcRequest = {
        id: "r8",
        method: "session.create",
        params: {
          configPath: "/bad/.zaps.mts",
          projectDir: "/bad",
          tmuxSession: "main",
          originPane: "%0",
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("load failed");
    });
  });

  describe("session.destroy", () => {
    it("destroys existing session", async () => {
      const session = createMockSession({ id: "s1" });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r9", method: "session.destroy", session: "s1" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.result).toEqual({ destroyed: "s1" });
      expect(store.destroy).toHaveBeenCalledWith("s1");
    });

    it("returns error when session required but missing", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r10", method: "session.destroy" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.error).toBe("session required");
    });

    it("returns error when session not found", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r11", method: "session.destroy", session: "unknown" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.error).toContain("Unknown session");
    });
  });
});
