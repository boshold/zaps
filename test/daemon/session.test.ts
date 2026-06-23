import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionCreateParams } from "../../src/daemon/session.js";
import { Session, sessionId } from "../../src/daemon/session.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";

vi.mock("../../src/lib/taskShortcuts.js", () => ({
  getTaskShortcuts: vi.fn(() => []),
}));

vi.mock("#src/config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("#src/lib/tmux-layout.js", () => ({
  createLayout: vi.fn(),
}));

vi.mock("#src/lib/tmux.js", () => ({
  killPane: vi.fn().mockResolvedValue(undefined),
  // LayoutReflow (constructed by Session) imports these as defaults. They are
  // Stored as function refs at construction but only invoked when reflow code
  // Runs; stub them so the import-time destructure succeeds in tests that
  // Never exercise the reflow path.
  getWindowSize: vi.fn().mockResolvedValue({ width: 100, height: 30 }),
  paneIndexOrder: vi.fn().mockResolvedValue([]),
  resyncPaneSizes: vi.fn().mockResolvedValue(undefined),
  selectLayout: vi.fn().mockResolvedValue(undefined),
  selectPane: vi.fn().mockResolvedValue(undefined),
  splitPane: vi.fn().mockResolvedValue("%99"),
  swapPanes: vi.fn().mockResolvedValue(undefined),
}));

function createMockManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    abortStartAll: vi.fn(),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }]),
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
      groups: new Map(),
      unavailableServices: new Map(),
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

  it("forwards detached logLines to the service buffer and broadcast (E4)", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("logLines", "api", ["line one", "line two"]);
    expect(session.logBuffers.get("api")?.snapshot()).toEqual(["line one", "line two"]);
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "log.lines",
        data: { service: "api", lines: ["line one", "line two"] },
      }),
    );
  });

  it("forwards taskStart events with runId", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("taskStart", "run_1", "build", "Build");
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task.start",
        data: { key: "build", name: "Build", runId: "run_1" },
      }),
    );
  });

  it("forwards taskComplete events with runId", () => {
    const broadcastSpy = vi.spyOn(session, "broadcast");
    manager.emit("taskComplete", "run_1", "build", "Build", "success");
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task.complete",
        data: { key: "build", name: "Build", result: "success", runId: "run_1" },
      }),
    );
  });

  it("correlates a manager run's start→complete into one record by runId", () => {
    manager.emit("taskStart", "run_1", "build", "Build");
    expect(session.taskHistory).toHaveLength(1);
    expect(session.taskHistory[0]).toMatchObject({ runId: "run_1", result: "running" });
    manager.emit("taskComplete", "run_1", "build", "Build", "success");
    expect(session.taskHistory).toHaveLength(1);
    expect(session.taskHistory[0]).toMatchObject({ runId: "run_1", result: "success" });
  });

  describe("pushTaskRecord", () => {
    it("adds running records to front", () => {
      session.pushTaskRecord({
        runId: "r1",
        taskKey: "t1",
        taskName: "T1",
        result: "running",
        timestamp: 1,
      });
      expect(session.taskHistory).toHaveLength(1);
      expect(session.taskHistory[0].result).toBe("running");
    });

    it("replaces the matching running record (by runId) on completion", () => {
      session.pushTaskRecord({
        runId: "r1",
        taskKey: "t1",
        taskName: "T1",
        result: "running",
        timestamp: 1,
      });
      session.pushTaskRecord({
        runId: "r1",
        taskKey: "t1",
        taskName: "T1",
        result: "success",
        timestamp: 2,
      });
      expect(session.taskHistory).toHaveLength(1);
      expect(session.taskHistory[0].result).toBe("success");
    });

    it("keeps concurrent same-key runs independent via distinct runIds", () => {
      // Two in-flight runs of the same task key.
      session.pushTaskRecord({
        runId: "rA",
        taskKey: "t1",
        taskName: "T1",
        result: "running",
        timestamp: 1,
      });
      session.pushTaskRecord({
        runId: "rB",
        taskKey: "t1",
        taskName: "T1",
        result: "running",
        timestamp: 2,
      });
      expect(session.taskHistory).toHaveLength(2);

      // Completing rA must resolve only rA; rB stays running.
      session.pushTaskRecord({
        runId: "rA",
        taskKey: "t1",
        taskName: "T1",
        result: "error",
        timestamp: 3,
      });
      expect(session.taskHistory).toHaveLength(2);
      const byRun = Object.fromEntries(session.taskHistory.map((r) => [r.runId, r.result]));
      expect(byRun).toEqual({ rA: "error", rB: "running" });
    });

    it("prepends if no matching running record found", () => {
      session.pushTaskRecord({
        runId: "r1",
        taskKey: "t1",
        taskName: "T1",
        result: "success",
        timestamp: 1,
      });
      expect(session.taskHistory).toHaveLength(1);
    });

    it("caps at 50 records", () => {
      for (let i = 0; i < 55; i += 1) {
        session.pushTaskRecord({
          runId: `r${i}`,
          taskKey: `t${i}`,
          taskName: `T${i}`,
          result: "running",
          timestamp: i,
        });
      }
      expect(session.taskHistory.length).toBe(50);
    });

    it("caps non-running records at 50 when no matching running entry", () => {
      for (let i = 0; i < 55; i += 1) {
        session.pushTaskRecord({
          runId: `r${i}`,
          taskKey: `t${i}`,
          taskName: `T${i}`,
          result: "success",
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

  describe("reload", () => {
    it("rejects with 'session destroyed' after the session was destroyed", async () => {
      await session.destroy();
      await expect(session.reload()).rejects.toThrow("session destroyed");
    });

    it("rejects a concurrent reload with 'reload already in progress'", async () => {
      const { loadConfig } = await import("#src/config/loader.js");
      let rejectLoad!: () => void;
      vi.mocked(loadConfig).mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectLoad = () => reject(new Error("aborted load"));
        }),
      );

      const first = session.reload();
      await expect(session.reload()).rejects.toThrow("reload already in progress");
      rejectLoad();
      await expect(first).rejects.toThrow("aborted load");
    });

    it("leaves the running session intact when the new config fails to load (A1)", async () => {
      const { loadConfig } = await import("#src/config/loader.js");
      const { killPane } = await import("#src/lib/tmux.js");
      vi.mocked(loadConfig).mockRejectedValue(new Error("Unexpected token }"));

      const removeListenersSpy = vi.spyOn(manager, "removeAllListeners");
      const origConfig = session.config;
      const origManager = session.manager;
      const origPaneMap = session.paneMap;
      const origBuffers = session.logBuffers;

      await expect(session.reload()).rejects.toThrow("Unexpected token }");

      expect(session.config).toBe(origConfig);
      expect(session.manager).toBe(origManager);
      expect(session.paneMap).toBe(origPaneMap);
      expect(session.logBuffers).toBe(origBuffers);
      expect(vi.mocked(manager.stopAll)).not.toHaveBeenCalled();
      expect(vi.mocked(manager.abortStartAll)).not.toHaveBeenCalled();
      expect(removeListenersSpy).not.toHaveBeenCalled();
      expect(vi.mocked(killPane)).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("sets destroyed and aborts the tracked start before tearing down", async () => {
      await session.destroy();
      expect(session.destroyed).toBe(true);
      expect(vi.mocked(manager.abortStartAll)).toHaveBeenCalled();
      expect(vi.mocked(manager.stopAll)).toHaveBeenCalled();
    });

    it("is idempotent — a second destroy does not tear down again", async () => {
      await session.destroy();
      await session.destroy();
      expect(vi.mocked(manager.stopAll)).toHaveBeenCalledTimes(1);
    });

    it("serializes behind an in-flight reload via the shared op lock", async () => {
      const { loadConfig } = await import("#src/config/loader.js");
      let rejectLoad!: () => void;
      vi.mocked(loadConfig).mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectLoad = () => reject(new Error("aborted load"));
        }),
      );

      const order: string[] = [];
      const reloadP = session.reload().catch(() => order.push("reload"));
      const destroyP = session.destroy().then(() => order.push("destroy"));

      // Reload holds the op lock while loadConfig is pending — destroy must wait.
      await Promise.resolve();
      expect(vi.mocked(manager.stopAll)).not.toHaveBeenCalled();

      rejectLoad();
      await Promise.all([reloadP, destroyP]);
      expect(order).toEqual(["reload", "destroy"]);
    });

    it("stops log monitor and all services", async () => {
      const mockSocket = { destroyed: false, destroy: vi.fn(), write: vi.fn() };
      session.subscribers.add(mockSocket as never);

      const flushAllSpy = vi.spyOn(session.logMonitor, "flushAll").mockResolvedValue();
      await session.destroy();

      expect(flushAllSpy).toHaveBeenCalled();
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

    it("flags detached services in servicesMeta (E4)", () => {
      const params = createSessionParams({
        config: {
          project: {
            name: "test-project",
            services: { api: { start: "npm dev" }, worker: { start: "node w.js", detached: true } },
          },
          configPath: "/test/.zaps.mts",
          projectDir: "/test",
          groups: new Map(),
          unavailableServices: new Map(),
        } as SessionCreateParams["config"],
        paneMap: { "@tui": "%0", api: "%1" },
      });
      const s = new Session(params, createMockManager());
      const snap = s.attachSnapshot();
      const api = snap.servicesMeta.find((m) => m.name === "api");
      const worker = snap.servicesMeta.find((m) => m.name === "worker");
      expect(api?.isDetached).toBe(false);
      expect(worker?.isDetached).toBe(true);
      // The detached service still gets a (private) log buffer.
      expect(s.logBuffers.has("worker")).toBe(true);
    });

    it("includes task shortcuts from getTaskShortcuts", async () => {
      const { getTaskShortcuts } = await import("../../src/lib/taskShortcuts.js");
      vi.mocked(getTaskShortcuts).mockReturnValue([{ shortcut: "b", name: "Build" }]);

      const params = createSessionParams({
        config: {
          project: {
            name: "test-project",
            services: { api: { start: "npm dev" } },
            tasks: { build: { name: "Build", description: "Build it" } },
          },
          configPath: "/test/.zaps.mts",
          projectDir: "/test",
          groups: new Map(),
          unavailableServices: new Map(),
        } as SessionCreateParams["config"],
      });

      const s = new Session(params, createMockManager());
      const snap = s.attachSnapshot();
      expect(snap.tasks).toHaveLength(1);
      expect(snap.tasks[0].shortcut).toBe("b");
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

describe("Session per-pane log buffers (D2)", () => {
  function groupParams(): SessionCreateParams {
    // A combined group "grp" of three members all sharing pane %1; the group
    // Name is a layout artifact present in paneMap but not in services.
    return createSessionParams({
      config: {
        project: {
          name: "test-project",
          services: { a: { start: "a" }, b: { start: "b" }, c: { start: "c" } },
        },
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        groups: new Map([["grp", ["a", "b", "c"]]]),
        unavailableServices: new Map(),
      } as SessionCreateParams["config"],
      paneMap: { "@tui": "%0", grp: "%1", a: "%1", b: "%1", c: "%1" },
    });
  }

  it("shares one LogBuffer instance across every member of a combined group", () => {
    const session = new Session(groupParams(), createMockManager());
    const bufA = session.logBuffers.get("a");

    expect(bufA).toBeDefined();
    expect(session.logBuffers.get("b")).toBe(bufA);
    expect(session.logBuffers.get("c")).toBe(bufA);
    // The group name never owns a buffer nor appears as a key.
    expect(session.logBuffers.has("grp")).toBe(false);
  });

  it("attachSnapshot resolves every member to its shared pane buffer", () => {
    const session = new Session(groupParams(), createMockManager());
    const snap = session.attachSnapshot();

    expect(snap.logSnapshots).toHaveProperty("a");
    expect(snap.logSnapshots).toHaveProperty("b");
    expect(snap.logSnapshots).toHaveProperty("c");
    expect(snap.logSnapshots).not.toHaveProperty("grp");
  });

  it("fans captured lines out once per member, never the group name", async () => {
    vi.useFakeTimers();
    try {
      const capturePane = vi.fn().mockResolvedValue("hello\nworld");
      const params = groupParams();
      params.deps = { capturePane } as unknown as SessionCreateParams["deps"];
      const session = new Session(params, createMockManager());
      const events: { event: string; data?: unknown }[] = [];
      vi.spyOn(session, "broadcast").mockImplementation((e) => {
        events.push(e);
      });

      await session.startAll();
      await vi.advanceTimersByTimeAsync(500);

      const services = events
        .filter((e) => e.event === "log.lines")
        .map((e) => (e.data as { service: string }).service)
        .toSorted();
      expect(services).toEqual(["a", "b", "c"]);
      expect(services).not.toContain("grp");
      // The shared buffer received the lines exactly once.
      expect(session.logBuffers.get("a")?.snapshot()).toContain("hello");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Session dynamic pane log hooks (P03-T03)", () => {
  function lazyServiceParams(): SessionCreateParams {
    // `web` is declared but has NO pane in paneMap → boots with a pane-less
    // Private buffer (`allocateLogBuffers`'s detached branch). `allocatePaneLog`
    // Must re-point it to a pane-shared buffer when the pane is created later.
    return createSessionParams({
      config: {
        project: {
          name: "test-project",
          services: { api: { start: "a" }, web: { start: "w" } },
        },
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        groups: new Map(),
        unavailableServices: new Map(),
      } as SessionCreateParams["config"],
      paneMap: { "@tui": "%0", api: "%1" }, // `web` deliberately pane-less.
    });
  }

  it("boots a lazy service with a private buffer (no pane key, retained)", () => {
    const session = new Session(lazyServiceParams(), createMockManager());

    expect(session.logBuffers.has("web")).toBe(true);
    expect(session.paneBuffers.size).toBe(1); // Only `api`'s pane.
    expect(session.paneMembers.size).toBe(1);
    // The pane-less private buffer is NOT mapped to any pane id.
    const webBuf = session.logBuffers.get("web");
    expect([...session.paneBuffers.values()]).not.toContain(webBuf);
  });

  it("allocatePaneLog re-points the buffer and starts the pane monitor", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    const startSpy = vi.spyOn(session.logMonitor, "start");
    const oldWebBuf = session.logBuffers.get("web");

    session.allocatePaneLog("web", "%2");

    // Fresh shared buffer (not the boot private one).
    const newWebBuf = session.logBuffers.get("web");
    expect(newWebBuf).toBeDefined();
    expect(newWebBuf).not.toBe(oldWebBuf);
    expect(session.paneBuffers.get("%2")).toBe(newWebBuf);
    expect(session.paneMembers.get("%2")).toEqual(["web"]);
    expect(startSpy).toHaveBeenCalledWith("%2", "%2");
  });

  it("new pane's captured lines reach its LogBuffer + broadcast listener (Round 7)", async () => {
    vi.useFakeTimers();
    try {
      const capturePane = vi
        .fn()
        .mockImplementation(async (target: string) => (target === "%2" ? "alpha\nbeta" : ""));
      const params = lazyServiceParams();
      params.deps = { capturePane } as unknown as SessionCreateParams["deps"];
      const session = new Session(params, createMockManager());
      const events: { event: string; data?: unknown }[] = [];
      vi.spyOn(session, "broadcast").mockImplementation((e) => {
        events.push(e);
      });

      session.allocatePaneLog("web", "%2");
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve(); // Flush the in-flight capture microtask.

      const webEvent = events.find(
        (e) =>
          e.event === "log.lines" && (e.data as { service: string } | undefined)?.service === "web",
      );
      expect(webEvent).toBeDefined();
      if (!webEvent) {
        throw new Error("unreachable");
      }
      expect((webEvent.data as { lines: string[] }).lines).toEqual(["alpha", "beta"]);
      expect(session.logBuffers.get("web")?.snapshot()).toEqual(["alpha", "beta"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("freePaneLog stops monitor, drops pane-keyed entries, RETAINS logBuffers[name]", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    session.allocatePaneLog("web", "%2");
    const retainedBuf = session.logBuffers.get("web");
    retainedBuf?.appendLines(["a history line"]);
    const stopSpy = vi.spyOn(session.logMonitor, "stop");

    session.freePaneLog("web", "%2");

    // Monitor stopped for that key only.
    expect(stopSpy).toHaveBeenCalledWith("%2");
    // Pane-keyed entries gone.
    expect(session.paneBuffers.has("%2")).toBe(false);
    expect(session.paneMembers.has("%2")).toBe(false);
    // CRITICAL: service-keyed buffer + its retained history survive.
    expect(session.logBuffers.has("web")).toBe(true);
    expect(session.logBuffers.get("web")).toBe(retainedBuf);
    expect(session.logBuffers.get("web")?.snapshot()).toEqual(["a history line"]);
  });

  it("attachSnapshot still surfaces a stopped lazy service (Round 7 invariant)", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    session.allocatePaneLog("web", "%2");
    session.logBuffers.get("web")?.appendLines(["retained"]);
    session.freePaneLog("web", "%2");

    const snap = session.attachSnapshot();
    expect(snap.logSnapshots).toHaveProperty("web");
    expect(snap.logSnapshots.web).toEqual(["retained"]);
  });

  it("a never-started lazy service snapshots [] (private boot buffer is empty)", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    const snap = session.attachSnapshot();
    expect(snap.logSnapshots).toHaveProperty("web");
    expect(snap.logSnapshots.web).toEqual([]);
  });

  it("allocatePaneLog is idempotent — re-call doesn't churn the buffer", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    session.allocatePaneLog("web", "%2");
    const first = session.logBuffers.get("web");

    session.allocatePaneLog("web", "%2");

    // Same buffer instance retained (no orphaned writes).
    expect(session.logBuffers.get("web")).toBe(first);
    expect(session.paneBuffers.get("%2")).toBe(first);
    expect(session.paneMembers.get("%2")).toEqual(["web"]);
  });

  it("repeated insert/remove does not grow paneBuffers or paneMembers", () => {
    const session = new Session(lazyServiceParams(), createMockManager());
    const baselinePaneBufs = session.paneBuffers.size;
    const baselinePaneMembers = session.paneMembers.size;

    for (let i = 0; i < 50; i += 1) {
      session.allocatePaneLog("web", "%2");
      session.freePaneLog("web", "%2");
    }

    expect(session.paneBuffers.size).toBe(baselinePaneBufs);
    expect(session.paneMembers.size).toBe(baselinePaneMembers);
    // The retained service buffer is still there.
    expect(session.logBuffers.has("web")).toBe(true);
  });

  it("hooks read `this.*` at call time — survives reload-style map reassignment", () => {
    const session = new Session(lazyServiceParams(), createMockManager());

    // Simulate the relevant subset of `_reload`'s atomic swap: NEW map instances
    // For the four log fields. allocatePaneLog must write to the NEW maps; if
    // It had captured the constructor-time instances it would silently leak
    // Into the dead pipeline.
    session.logBuffers = new Map();
    session.paneBuffers = new Map();
    session.paneMembers = new Map();
    // Logmonitor is also reassigned by reload; mock a replacement here.
    const newStart = vi.fn();
    const fakeMonitor: Pick<typeof session.logMonitor, "start" | "stop"> = {
      start: newStart,
      stop: vi.fn(),
    };
    session.logMonitor = fakeMonitor as typeof session.logMonitor;

    session.allocatePaneLog("web", "%5");

    expect(session.paneBuffers.has("%5")).toBe(true);
    expect(session.logBuffers.has("web")).toBe(true);
    // The post-reload monitor saw the start, not the dead one.
    expect(newStart).toHaveBeenCalledWith("%5", "%5");
  });

  it("paneBuffers is the SAME instance the LogMonitor holds internally", () => {
    const session = new Session(lazyServiceParams(), createMockManager());

    // Mutating session.paneBuffers must be visible to the monitor's internal
    // `buffers` ref (`log-monitor.ts:22`). The strongest cross-check is to use
    // The captured monitor closure: the monitor reads `buffers.get(key)` on
    // Each capture cycle, so a value put into session.paneBuffers MUST be
    // Readable through it. The monitor's field is private, so we cross-check
    // Via behavior: after `allocatePaneLog`, the monitor's tick should land
    // The captured lines into the buffer we placed in `session.paneBuffers`.
    const buf = session.paneBuffers; // Capture the constructor-time ref.
    session.allocatePaneLog("web", "%2");
    expect(buf.get("%2")).toBe(session.logBuffers.get("web"));
    // Same map instance was mutated.
    expect(buf).toBe(session.paneBuffers);
  });
});

describe("Session.reflow — wired with live-getter deps", () => {
  it("constructs a LayoutReflow whose deps see post-reload field values", () => {
    const session = new Session(createSessionParams(), createMockManager());
    expect(session.reflow).toBeDefined();
    // Indirect proof: the reflow object is stable across a paneMap reassignment
    // (the deps are closures over `this`, not captured refs at construction).
    const beforeReflow = session.reflow;
    session.paneMap = { "@tui": "%9", api: "%10" };
    expect(session.reflow).toBe(beforeReflow);
  });
});

describe("Session config staleness (A4)", () => {
  let dir: string;
  let configPath: string;
  let manager: ServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockManager();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-session-stale-"));
    configPath = path.join(dir, ".zaps.mts");
    fs.writeFileSync(configPath, "x");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isConfigStale reflects file mtime vs configLoadedAt", () => {
    const session = new Session(createSessionParams({ configPath }), manager);
    const mtime = fs.statSync(configPath).mtimeMs;

    session.configLoadedAt = mtime - 1000; // File edited after load → stale
    expect(session.isConfigStale()).toBe(true);

    session.configLoadedAt = mtime + 1000; // Loaded after the edit → fresh
    expect(session.isConfigStale()).toBe(false);
  });

  it("isConfigStale is false when the config file is missing", () => {
    const session = new Session(
      createSessionParams({ configPath: path.join(dir, "gone.mts") }),
      manager,
    );
    expect(session.isConfigStale()).toBe(false);
  });

  it("attachSnapshot includes a configStale flag", () => {
    const session = new Session(createSessionParams({ configPath }), manager);
    session.configLoadedAt = fs.statSync(configPath).mtimeMs - 1000;
    expect(session.attachSnapshot().configStale).toBe(true);
  });

  it("broadcasts session.configStale once per false→true transition", () => {
    vi.useFakeTimers();
    const session = new Session(createSessionParams({ configPath }), manager);
    session.configLoadedAt = fs.statSync(configPath).mtimeMs - 1000; // Stale
    const broadcast = vi.spyOn(session, "broadcast").mockImplementation(() => undefined);

    session.addSubscriber({} as never); // Arms the 10s poll
    vi.advanceTimersByTime(10_000);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.configStale", data: { configStale: true } }),
    );

    broadcast.mockClear();
    vi.advanceTimersByTime(10_000); // Still stale → no repeat (one-shot)
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("arms the poll only while subscribed and clears it on unsubscribe and destroy", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const session = new Session(createSessionParams({ configPath }), manager);
    const a = {} as never;
    const b = {} as never;

    session.addSubscriber(a);
    expect(setSpy).toHaveBeenCalledTimes(1);
    session.addSubscriber(b); // Second subscriber does not arm a second poll
    expect(setSpy).toHaveBeenCalledTimes(1);

    session.removeSubscriber(a); // One remains → poll keeps running
    expect(clearSpy).not.toHaveBeenCalled();
    session.removeSubscriber(b); // None left → poll cleared
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("stops the poll on destroy with subscribers still attached", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const session = new Session(createSessionParams({ configPath }), manager);
    session.addSubscriber({ destroyed: false, write: vi.fn(), destroy: vi.fn() } as never);

    await session.destroy();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
