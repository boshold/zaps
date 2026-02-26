import { EventEmitter } from "node:events";

import type { ServiceManager } from "../../src/lib/service/manager.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Session, sessionId } from "../../src/daemon/session.js";
import type { SessionCreateParams } from "../../src/daemon/session.js";

vi.mock("../../src/lib/taskShortcuts.js", () => ({
  getTaskShortcuts: vi.fn(() => []),
}));

function createMockManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => [
      { name: "api", state: "ready", ports: [3000], retryCount: 0 },
    ]),
    getStatus: vi.fn(),
  }) as unknown as ServiceManager;
}

function createSessionParams(overrides?: Partial<SessionCreateParams>): SessionCreateParams {
  return {
    configPath: "/test/.zaps.mts",
    projectDir: "/test",
    config: {
      project: {
        name: "test-project",
        services: { api: { start: "npm dev" } },
      },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
    } as SessionCreateParams["config"],
    paneMap: { "@tui": "%0", api: "%1" },
    tmuxSession: "main",
    originPane: "%0",
    deps: {
      capturePane: vi.fn().mockResolvedValue(""),
    } as unknown as SessionCreateParams["deps"],
    ...overrides,
  };
}

describe("sessionId", () => {
  it("returns 12-char hex hash of configPath", () => {
    const id = sessionId("/test/.zaps.mts");
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  it("is deterministic", () => {
    expect(sessionId("/foo")).toBe(sessionId("/foo"));
  });

  it("produces different IDs for different paths", () => {
    expect(sessionId("/a")).not.toBe(sessionId("/b"));
  });
});

describe("Session", () => {
  let manager: ServiceManager;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockManager();
    session = new Session(createSessionParams(), manager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes with correct properties", () => {
    expect(session.id).toMatch(/^[a-f0-9]{12}$/);
    expect(session.name).toBe("test-project");
    expect(session.configPath).toBe("/test/.zaps.mts");
    expect(session.projectDir).toBe("/test");
    expect(session.paneMap).toHaveProperty("@tui");
  });

  it("creates log buffers per service", () => {
    expect(session.logBuffers.has("api")).toBe(true);
    expect(session.logBuffers.size).toBe(1);
  });

  it("forwards stateChange events to broadcast", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("stateChange", "api", { name: "api", state: "ready" });
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.stateChange",
        data: { name: "api", status: { name: "api", state: "ready" } },
      }),
    );
  });

  it("forwards taskStart events", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("taskStart", "build", "Build");
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task.start",
        data: { key: "build", name: "Build" },
      }),
    );
  });

  it("forwards taskComplete events", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("taskComplete", "build", "Build", "success");
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task.complete",
        data: { key: "build", name: "Build", result: "success" },
      }),
    );
  });

  describe("pushTaskRecord", () => {
    it("adds running records to front", () => {
      session.pushTaskRecord({ taskKey: "t1", taskName: "T1", result: "running", timestamp: 1 });
      expect(session.taskHistory).toHaveLength(1);
      expect(session.taskHistory[0].result).toBe("running");
    });

    it("replaces matching running record on completion", () => {
      session.pushTaskRecord({ taskKey: "t1", taskName: "T1", result: "running", timestamp: 1 });
      session.pushTaskRecord({ taskKey: "t1", taskName: "T1", result: "success", timestamp: 2 });
      expect(session.taskHistory).toHaveLength(1);
      expect(session.taskHistory[0].result).toBe("success");
    });

    it("prepends if no matching running record found", () => {
      session.pushTaskRecord({ taskKey: "t1", taskName: "T1", result: "success", timestamp: 1 });
      expect(session.taskHistory).toHaveLength(1);
    });

    it("caps at 50 records", () => {
      for (let i = 0; i < 55; i += 1) {
        session.pushTaskRecord({
          taskKey: `t${i}`,
          taskName: `T${i}`,
          result: "running",
          timestamp: i,
        });
      }
      expect(session.taskHistory.length).toBe(50);
    });
  });

  describe("startAll", () => {
    it("delegates to manager.startAll and starts log monitoring", async () => {
      await session.startAll();
      expect(vi.mocked(manager.startAll)).toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("stops log monitor and all services", async () => {
      const mockSocket = { destroyed: false, destroy: vi.fn(), write: vi.fn() };
      session.subscribers.add(mockSocket as never);

      const stopAllSpy = vi.spyOn(session.logMonitor, "stopAll");
      await session.destroy();

      expect(stopAllSpy).toHaveBeenCalled();
      expect(vi.mocked(manager.stopAll)).toHaveBeenCalled();
      expect(session.subscribers.size).toBe(0);
    });

    it("broadcasts session.destroyed event", async () => {
      const broadcastSpy = vi.spyOn(session, "broadcast");
      await session.destroy();
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.destroyed" }),
      );
    });
  });

  describe("attachSnapshot", () => {
    it("returns full snapshot", () => {
      const snap = session.attachSnapshot();
      expect(snap.id).toBe(session.id);
      expect(snap.name).toBe("test-project");
      expect(snap.paneMap).toEqual(session.paneMap);
      expect(snap.statuses).toBeDefined();
      expect(snap.logSnapshots).toHaveProperty("api");
      expect(snap.tasks).toBeDefined();
      expect(snap.servicesMeta).toBeDefined();
    });
  });

  describe("broadcast", () => {
    it("writes JSON to all subscribers", () => {
      const sock1 = { destroyed: false, write: vi.fn() };
      const sock2 = { destroyed: false, write: vi.fn() };
      session.subscribers.add(sock1 as never);
      session.subscribers.add(sock2 as never);

      session.broadcast({ session: session.id, event: "test", data: null });

      expect(sock1.write).toHaveBeenCalledWith(expect.stringContaining('"event":"test"'));
      expect(sock2.write).toHaveBeenCalledWith(expect.stringContaining('"event":"test"'));
    });

    it("removes destroyed sockets", () => {
      const sock = { destroyed: true, write: vi.fn() };
      session.subscribers.add(sock as never);

      session.broadcast({ session: session.id, event: "test", data: null });

      expect(session.subscribers.has(sock as never)).toBe(false);
      expect(sock.write).not.toHaveBeenCalled();
    });
  });
});
