import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConfig, ServiceConfig } from "#src/config/types.js";
import { ShellSessionBackend } from "#src/lib/backend/shell/session.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type {
  BackendCapabilities,
  PresentationDriver,
  PresentationSnapshot,
  RuntimeDriver,
  SessionBackend,
} from "#src/lib/backend/types.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { daemonHandlers } from "../../src/daemon/handlers/daemon.js";
import { sessionHandlers } from "../../src/daemon/handlers/session.js";
import type { SessionCreateParams } from "../../src/daemon/session.js";
import { Session, sessionId } from "../../src/daemon/session.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";
import { createMockStore } from "../_helpers/mock-session.js";
import { managerDependencies } from "../_helpers/service-runtime.js";
import type { ServiceManagerFixtureDeps as ServiceManagerDeps } from "../_helpers/service-runtime.js";
import type { TmuxFixtureParams } from "../_helpers/session-backend.js";
import { createTmuxSession } from "../_helpers/session-backend.js";

vi.mock("../../src/lib/taskShortcuts.js", () => ({
  getTaskShortcuts: vi.fn(() => []),
}));

vi.mock("#src/config/loader.js", () => ({
  loadConfig: vi.fn(),
  // P04-T03: rebuildLayout calls computeBootSkip during reload.
  computeBootSkip: vi.fn(() => new Set<string>()),
}));

// Only `createLayout` is stubbed: the pure tree helpers (`filterTree`, …) stay
// Real so the reflow path can actually run.
vi.mock("#src/lib/tmux-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/lib/tmux-layout.js")>()),
  createLayout: vi.fn(),
}));

vi.mock("#src/lib/tmux.js", () => {
  // The Session binds its handle via `tmuxFor(tmuxSocket)`, so the factory
  // Returns the SAME stub surface for both the module exports and the handle —
  // Assertions on the named exports still observe every call.
  let socket: string | null = null;
  const api = {
    getSocket: () => socket,
    displayMessage: vi.fn().mockResolvedValue("0"),
    hasSession: vi.fn().mockResolvedValue(false),
    paneExists: vi.fn().mockResolvedValue(false),
    killPane: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    // LayoutReflow (constructed by Session) uses these as defaults. They are
    // Stored as function refs at construction but only invoked when reflow code
    // Runs; stub them so tests that never exercise the reflow path still work.
    getWindowSize: vi.fn().mockResolvedValue({ width: 100, height: 30 }),
    paneIndexOrder: vi.fn().mockResolvedValue([]),
    resyncPaneSizes: vi.fn().mockResolvedValue(undefined),
    selectLayout: vi.fn().mockResolvedValue(undefined),
    selectPane: vi.fn().mockResolvedValue(undefined),
    splitPane: vi.fn().mockResolvedValue("%99"),
    swapPanes: vi.fn().mockResolvedValue(undefined),
    windowLayout: vi.fn().mockResolvedValue("prior-layout-string"),
  };
  // Real implementation: the exact-target form is what these tests assert on.
  return {
    ...api,
    exactWindowTarget: (name: string) => `=${name}:`,
    tmuxFor: vi.fn((value: string | null) => {
      socket = value;
      return api;
    }),
  };
});

function createMockManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    disposeObservers: vi.fn(),
    resumeRuntimeObserver: vi.fn(),
    abortStartAll: vi.fn(),
    closeAdmission: vi.fn(),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }]),
    getStatus: vi.fn(),
  }) as unknown as ServiceManager;
}

async function createSessionParams(
  overrides?: Partial<TmuxFixtureParams & { paneMap: Record<string, string> }>,
) {
  const { createLayout } = await import("#src/lib/tmux-layout.js");
  vi.mocked(createLayout).mockResolvedValueOnce({
    paneMap: overrides?.paneMap ?? { "@tui": "%0", api: "%1" },
    focusPane: "%0",
  });
  return createTmuxSession({
    configPath: "/test/.zaps.mts",
    projectDir: "/test",
    tmuxSocket: null,
    managedTmux: false,
    config: {
      project: {
        name: "test-project",
        services: { api: { start: "npm dev" } },
      },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      groups: new Map(),
      unavailableServices: new Map(),
      lazyPaneByService: new Map(),
    } as SessionCreateParams["config"],
    tmuxSession: "main",
    tmuxWindow: "@1",
    originPane: "%0",
    deps: {
      runtime: () => ({
        closeAdmission: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        isRunning: vi.fn(),
        getPid: vi.fn(),
        readOutput: vi.fn(),
        subscribe: vi.fn(),
      }),
      inspectPorts: vi.fn(async () => []),
      sendKeys: vi.fn(),
      sendCtrlC: vi.fn(),
      panePid: vi.fn(),
      detectPorts: vi.fn(),
      capturePane: vi.fn(async () => ""),
      getDescendantPids: vi.fn(),
      renameWindow: vi.fn(),
      getWindowName: vi.fn(),
      getWindowOption: vi.fn(),
      setWindowOption: vi.fn(),
      displayPopup: vi.fn(),
      exec: vi.fn(),
      preflightPorts: vi.fn(async () => null),
      storeExecInfo: vi.fn(),
      sessionId: "test",
      zapsCommand: "zaps",
      reflowInsert: vi.fn(),
      reflowRemove: vi.fn(),
    },
    ...overrides,
  });
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

  it("includes the resolved project root", () => {
    expect(sessionId("/shared/.zaps.mts", "/a")).not.toBe(sessionId("/shared/.zaps.mts", "/b"));
  });
});

describe("Session", () => {
  let manager: ServiceManager;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = createMockManager();
    session = new Session(await createSessionParams(), manager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("UI socket binding", () => {
    it("requires acknowledged subscription on the same socket and session", async () => {
      const socket = new Socket();
      const otherSocket = new Socket();
      const other = new Session(
        await createSessionParams({ configPath: "/other/.zaps.mts" }),
        createMockManager(),
      );
      const store = {
        ...createMockStore(),
        get: (id: string) => [session, other].find((entry) => entry.id === id),
      };
      const attach = async (target = session, client = socket) =>
        sessionHandlers["session.attach"](
          { id: "attach", method: "session.attach", session: target.id, params: { ui: true } },
          store,
          client,
        );
      const response1 = await attach();
      expect(response1.error).toBe("invalid_request");
      session.addSubscriber(socket);
      const response2 = await attach();
      expect(response2.error).toBe("invalid_request");
      session.subscriberAcknowledgement(socket)();
      const response3 = await attach(session, otherSocket);
      expect(response3.error).toBe("invalid_request");
      const response4 = await attach(other);
      expect(response4.error).toBe("invalid_request");
      const response5 = await attach();
      expect(response5.error).toBeUndefined();
      expect(session.getUiBinding(socket)).toMatchObject({ socket, sessionId: session.id });
      const binding = session.getUiBinding(socket);
      expect(binding?.acknowledged).toBe(false);
      session.uiBindingAcknowledgement(socket)();
      expect(binding?.acknowledged).toBe(true);
      other.addSubscriber(socket);
      const response6 = await attach(other);
      expect(response6.error).toBe("invalid_request");
      other.subscriberAcknowledgement(socket)();
      const response7 = await attach(other);
      expect(response7.error).toBeUndefined();
      await sessionHandlers["session.detach"](
        { id: "detach", method: "session.detach", session: session.id },
        store,
        socket,
      );
      expect(session.getUiBinding(socket)).toBeUndefined();
      expect(other.getUiBinding(socket)).toBeDefined();
      expect(binding?.controller.signal.aborted).toBe(true);
      const response8 = await attach();
      expect(response8.error).toBe("invalid_request");
      other.removeSubscriber(socket);
      socket.destroy();
      otherSocket.destroy();
    });

    it("rejects closed sockets and requires fresh ACKs after removal", () => {
      const socket = new Socket();
      session.addSubscriber(socket);
      session.subscriberAcknowledgement(socket)();
      session.bindUi(socket);
      session.removeSubscriber(socket);
      session.addSubscriber(socket);
      expect(() => session.bindUi(socket)).toThrow("invalid_request");
      session.subscriberAcknowledgement(socket)();
      session.bindUi(socket);
      socket.destroy();
      expect(() => session.bindUi(socket)).toThrow("invalid_request");
      session.removeSubscriber(socket);
      expect(session.getUiBinding(socket)).toBeUndefined();
      expect(socket.listenerCount("close")).toBe(0);
    });

    it("closes binding admission immediately when destroy begins", async () => {
      const socket = new Socket();
      session.addSubscriber(socket);
      session.subscriberAcknowledgement(socket)();
      session.bindUi(socket);
      const binding = session.getUiBinding(socket);
      const destruction = session.destroy();
      expect(binding?.controller.signal.aborted).toBe(true);
      expect(session.getUiBinding(socket)).toBeUndefined();
      expect(() => session.bindUi(socket)).toThrow("session_closing");
      await destruction;
      expect(session.getUiBinding(socket)).toBeUndefined();
    });
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
    manager.emit("stateChange", "api", {
      name: "api",
      state: "ready",
      ports: [3000],
      retryCount: 0,
    });
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.stateChange",
        data: {
          name: "api",
          status: {
            name: "api",
            state: "ready",
            ports: [3000],
            retryCount: 0,
            paneId: "%1",
            actions: { focus: true, zoom: false, editOutput: false },
          },
        },
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

  it("owns task lifecycle/output independently of manager events", async () => {
    session.config.project.tasks = {
      dep: {
        name: "Dep",
        run: async (ctx) => {
          ctx.stdout.write("dependency output\n");
        },
      },
      build: {
        name: "Build",
        dependsOn: ["dep"],
        run: async (ctx) => {
          ctx.stdout.write("root output\n");
        },
      },
    };
    const broadcastSpy = vi.spyOn(session, "broadcast");
    const result = await session.taskExecution.run("build", {
      config: session.config,
      cwd: session.projectDir,
      env: {},
      mode: "background",
    });
    expect(result.success).toBe(true);
    expect(session.taskHistory).toEqual([
      expect.objectContaining({ runId: result.runId, taskKey: "build", result: "success" }),
    ]);
    expect(session.taskOutput.get(result.runId)?.lines).toEqual([
      "dependency output",
      "root output",
    ]);
    expect(broadcastSpy.mock.calls.map(([event]) => event.event)).toEqual([
      "task.start",
      "task.complete",
    ]);
  });

  it("drops a throwing subscriber without interrupting retained task completion", async () => {
    const socket = new Socket();
    vi.spyOn(socket, "write").mockImplementation(() => {
      throw new Error("closed socket");
    });
    session.subscribers.add(socket);
    session.config.project.tasks = {
      root: {
        name: "Root",
        run: async (ctx) => {
          ctx.stdout.write("retained output");
        },
      },
    };
    const result = await session.taskExecution.run("root", {
      config: session.config,
      cwd: session.projectDir,
      env: {},
      mode: "background",
    });
    expect(result.success).toBe(true);
    expect(session.subscribers.has(socket)).toBe(false);
    expect(session.taskOutput.get(result.runId)?.lines).toEqual(["retained output"]);
    expect(session.taskHistory).toEqual([
      expect.objectContaining({ taskKey: "root", result: "success" }),
    ]);
    socket.destroy();
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

  it("keeps one task owner and its sinks through manager replacement", async () => {
    const owner = session.taskExecution;
    const output = session.taskOutput;
    const history = session.taskHistory;
    let finish: () => void = () => {
      throw new Error("not started");
    };
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    session.config.project.tasks = {
      build: {
        name: "Build",
        run: async (ctx) => {
          await pending;
          ctx.stdout.write("after replacement\n");
        },
      },
    };
    const run = owner.run("build", {
      config: session.config,
      cwd: session.projectDir,
      env: session.env,
      mode: "background",
    });
    manager.removeAllListeners();
    session.manager = createMockManager();
    finish();
    const result = await run;
    expect(session.taskExecution).toBe(owner);
    expect(session.taskOutput).toBe(output);
    expect(session.taskHistory).toBe(history);
    expect(output.get(result.runId)?.lines).toEqual(["after replacement"]);
    expect(history[0]).toMatchObject({ runId: result.runId, result: "success" });
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

    it("closes service/process admission synchronously and attempts every cleanup after failures", async () => {
      const closeManager = vi.fn();
      Object.assign(manager, { closeAdmission: closeManager });
      const closeRuntime = vi.fn();
      Object.assign(session.backend.runtime, { closeAdmission: closeRuntime });
      vi.mocked(manager.stopAll).mockRejectedValueOnce(new Error("service stop failed"));
      const taskDisposal = vi
        .spyOn(session.taskExecution, "dispose")
        .mockRejectedValueOnce(new Error("task cleanup failed"));
      const backendDisposal = vi
        .spyOn(session.backend, "dispose")
        .mockRejectedValueOnce(new Error("host cleanup failed"));
      const pending = session.destroy();
      expect(closeManager).toHaveBeenCalledOnce();
      expect(closeRuntime).toHaveBeenCalledOnce();
      expect(session.taskExecution.accepting).toBe(false);
      await expect(pending).rejects.toThrow("Session cleanup incomplete");
      expect(taskDisposal).toHaveBeenCalledOnce();
      expect(backendDisposal).toHaveBeenCalledOnce();
      await expect(session.destroy()).rejects.toThrow("Session cleanup incomplete");
    });

    it("is idempotent — a second destroy does not tear down again", async () => {
      await session.destroy();
      await session.destroy();
      expect(vi.mocked(manager.stopAll)).toHaveBeenCalledTimes(1);
    });

    it("kills the tmux session zaps owns, by exact name (F5)", async () => {
      const { killSession, tmuxFor } = await import("#src/lib/tmux.js");
      vi.mocked(killSession).mockClear();
      const managed = new Session(
        await createSessionParams({
          tmuxSocket: "zaps",
          managedTmux: true,
          tmuxSession: "zaps-app-abc123abc123",
        }),
        createMockManager(),
      );
      await managed.destroy();
      expect(killSession).toHaveBeenCalledWith("zaps-app-abc123abc123");
      // On the session's own socket handle — never the default server.
      expect(tmuxFor).toHaveBeenCalledWith("zaps");
    });

    it("never kills a tmux session zaps does not own", async () => {
      const { killSession } = await import("#src/lib/tmux.js");
      vi.mocked(killSession).mockClear();
      await session.destroy();
      expect(killSession).not.toHaveBeenCalled();
    });

    it("treats an already-gone tmux session as non-fatal", async () => {
      const { killSession } = await import("#src/lib/tmux.js");
      vi.mocked(killSession).mockRejectedValueOnce(new Error("can't find session"));
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const managed = new Session(
        await createSessionParams({
          tmuxSocket: "zaps",
          managedTmux: true,
          tmuxSession: "zaps-gone",
        }),
        createMockManager(),
      );
      await expect(managed.destroy()).resolves.toBeUndefined();
      expect(managed.destroyed).toBe(true);

      stderr.mockRestore();
    });

    it("stops the services before killing the tmux session that hosts them", async () => {
      const { killSession } = await import("#src/lib/tmux.js");
      vi.mocked(killSession).mockClear();
      const order: string[] = [];
      const managed = createMockManager();
      vi.mocked(managed.stopAll).mockImplementation(async () => {
        order.push("stopAll");
      });
      vi.mocked(killSession).mockImplementation(async () => {
        order.push("killSession");
      });
      await new Session(
        await createSessionParams({ tmuxSocket: "zaps", managedTmux: true }),
        managed,
      ).destroy();
      expect(order).toEqual(["stopAll", "killSession"]);
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

      await session.destroy();

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

  describe("managed tmux context", () => {
    it("defaults to the user's default server", () => {
      expect(session.backend.getPresentation()).toMatchObject({ tmuxSocket: null });
      expect(session.compatibilityProjection().managed).toBe(false);
    });

    it("binds its tmux handle to the session socket", async () => {
      const { tmuxFor } = await import("#src/lib/tmux.js");
      vi.mocked(tmuxFor).mockClear();
      const managed = new Session(
        await createSessionParams({ tmuxSocket: "zaps", managedTmux: true }),
        createMockManager(),
      );
      expect(managed.backend.getPresentation()).toMatchObject({ tmuxSocket: "zaps" });
      expect(managed.compatibilityProjection().managed).toBe(true);
      expect(tmuxFor).toHaveBeenCalledWith("zaps");
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
      expect(snap.tmuxSession).toBe(session.compatibilityProjection().tmuxSession);
      expect(snap.managed).toBe(false);
    });

    it("reports managed sessions so the client can route attach/teardown", async () => {
      const managed = new Session(
        await createSessionParams({ tmuxSocket: "zaps", managedTmux: true }),
        createMockManager(),
      );
      expect(managed.attachSnapshot().managed).toBe(true);
    });

    it("flags detached services in servicesMeta (E4)", async () => {
      const params = await createSessionParams({
        config: {
          project: {
            name: "test-project",
            services: { api: { start: "npm dev" }, worker: { start: "node w.js", detached: true } },
          },
          configPath: "/test/.zaps.mts",
          projectDir: "/test",
          groups: new Map(),
          unavailableServices: new Map(),
          lazyPaneByService: new Map(),
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

      const params = await createSessionParams({
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
          lazyPaneByService: new Map(),
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

describe("Session execution-unit log buffers", () => {
  async function groupParams(): Promise<SessionCreateParams> {
    // A combined group "grp" of three members all sharing pane %1; the group
    // Name is a layout artifact present in paneMap but not in services.
    return await createSessionParams({
      config: {
        project: {
          name: "test-project",
          services: Object.fromEntries(
            ["a", "b", "c"].map((name) => [
              name,
              {
                start: name,
                _combined: { group: "grp", allServices: ["a", "b", "c"], isOwner: name === "a" },
              },
            ]),
          ),
        },
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        groups: new Map([["grp", ["a", "b", "c"]]]),
        unavailableServices: new Map(),
        lazyPaneByService: new Map(),
      } as SessionCreateParams["config"],
      paneMap: { "@tui": "%0", grp: "%1", a: "%1", b: "%1", c: "%1" },
    });
  }

  it("shares one LogBuffer instance across every member of a combined group", async () => {
    const session = new Session(await groupParams(), createMockManager());
    const bufA = session.logBuffers.get("a");

    expect(bufA).toBeDefined();
    expect(session.logBuffers.get("b")).toBe(bufA);
    expect(session.logBuffers.get("c")).toBe(bufA);
    // The group name never owns a buffer nor appears as a key.
    expect(session.logBuffers.has("grp")).toBe(false);
  });

  it("attachSnapshot resolves every member to its shared pane buffer", async () => {
    const session = new Session(await groupParams(), createMockManager());
    const snap = session.attachSnapshot();

    expect(snap.logSnapshots).toHaveProperty("a");
    expect(snap.logSnapshots).toHaveProperty("b");
    expect(snap.logSnapshots).toHaveProperty("c");
    expect(snap.logSnapshots).not.toHaveProperty("grp");
  });

  it("fans captured lines out once per member, never the group name", async () => {
    vi.useFakeTimers();
    try {
      const params = await groupParams();
      const manager = createMockManager();
      const session = new Session(params, manager);
      const events: { event: string; data?: unknown }[] = [];
      vi.spyOn(session, "broadcast").mockImplementation((e) => {
        events.push(e);
      });

      await session.startAll();
      for (const name of ["a", "b", "c"]) {
        manager.emit("logLines", name, ["hello", "world"]);
      }

      const services = events
        .filter((e) => e.event === "log.lines")
        .map((e) => (e.data as { service: string }).service)
        .toSorted();
      expect(services).toEqual(["a", "b", "c"]);
      expect(services).not.toContain("grp");
      // The shared buffer received the lines exactly once.
      expect(session.logBuffers.get("a")?.snapshot()).toEqual(["hello", "world"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Session.reflow — wired with live-getter deps", () => {
  it("targets the stored tmux window", async () => {
    const params = await createSessionParams({
      tmuxSession: "zaps-app-a1",
      tmuxWindow: "@7",
      paneMap: { "@tui": "%0", api: "%1" },
      config: {
        project: {
          name: "test-project",
          services: { api: { start: "npm dev" } },
          layout: { direction: "columns", children: [{ pane: "@tui" }, { pane: "api" }] },
        },
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        groups: new Map(),
        unavailableServices: new Map(),
        lazyPaneByService: new Map(),
      } as SessionCreateParams["config"],
    });

    const tmux = await import("#src/lib/tmux.js");
    vi.mocked(tmux.paneIndexOrder).mockResolvedValueOnce([
      { index: 0, id: "%0" },
      { index: 1, id: "%1" },
    ]);

    await params.backend.reconcileLayout({
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    });

    // One getter feeds every window-scoped call site (incl. insert/remove's
    // `windowLayout` snapshot), so pinning the geometry path pins them all.
    expect(tmux.getWindowSize).toHaveBeenCalledWith("@7");
    expect(tmux.paneIndexOrder).toHaveBeenCalledWith("@7");
    expect(tmux.selectLayout).toHaveBeenCalledWith("@7", expect.any(String));
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

  it("isConfigStale reflects file mtime vs configLoadedAt", async () => {
    const session = new Session(await createSessionParams({ configPath }), manager);
    const mtime = fs.statSync(configPath).mtimeMs;

    session.configLoadedAt = mtime - 1000; // File edited after load → stale
    expect(session.isConfigStale()).toBe(true);

    session.configLoadedAt = mtime + 1000; // Loaded after the edit → fresh
    expect(session.isConfigStale()).toBe(false);
  });

  it("isConfigStale is false when the config file is missing", async () => {
    const session = new Session(
      await createSessionParams({ configPath: path.join(dir, "gone.mts") }),
      manager,
    );
    expect(session.isConfigStale()).toBe(false);
  });

  it("attachSnapshot includes a configStale flag", async () => {
    const session = new Session(await createSessionParams({ configPath }), manager);
    session.configLoadedAt = fs.statSync(configPath).mtimeMs - 1000;
    expect(session.attachSnapshot().configStale).toBe(true);
  });

  it("broadcasts session.configStale once per false→true transition", async () => {
    vi.useFakeTimers();
    const session = new Session(await createSessionParams({ configPath }), manager);
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

  it("arms the poll only while subscribed and clears it on unsubscribe and destroy", async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const session = new Session(await createSessionParams({ configPath }), manager);
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
    const session = new Session(await createSessionParams({ configPath }), manager);
    session.addSubscriber({ destroyed: false, write: vi.fn(), destroy: vi.fn() } as never);

    await session.destroy();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

function presentationFixture(services: Record<string, ServiceConfig>, statuses: ServiceStatus[]) {
  const config: ResolvedConfig = {
    project: { name: "projection", services },
    configPath: "/test/projection.zaps.ts",
    projectDir: "/test",
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
  const runtime: RuntimeDriver = {
    closeAdmission: vi.fn(),
    start: vi.fn(async () => {
      throw new Error("Unexpected execution");
    }),
    stop: vi.fn<RuntimeDriver["stop"]>().mockResolvedValue(undefined),
    isRunning: vi.fn(async () => false),
    getPid: vi.fn(async () => undefined),
    readOutput: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  };
  const unused = async () => {
    throw new Error("Unexpected terminal dependency");
  };
  const deps: ServiceManagerDeps = {
    runtime: () => runtime,
    inspectPorts: unused,
    sendKeys: unused,
    sendCtrlC: unused,
    panePid: unused,
    detectPorts: unused,
    capturePane: unused,
    getDescendantPids: unused,
    renameWindow: unused,
    getWindowName: unused,
    getWindowOption: unused,
    setWindowOption: unused,
    displayPopup: unused,
    exec: unused,
    preflightPorts: unused,
    storeExecInfo: () => {
      throw new Error("Unexpected execution");
    },
    sessionId: "projection",
    zapsCommand: "zaps",
    reflowInsert: unused,
    reflowRemove: unused,
  };
  const manager = createMockManager();
  vi.spyOn(manager, "getAllStatuses").mockReturnValue(statuses);
  return { config, deps, manager, runtime };
}

function observedBackend(
  runtime: RuntimeDriver,
  capabilities: BackendCapabilities,
  initial: PresentationSnapshot,
) {
  let view = initial;
  const listeners = new Set<(next: PresentationSnapshot) => void>();
  const backend: Omit<SessionBackend, "presentation"> & { presentation?: PresentationDriver } = {
    id: "tmux",
    capabilities,
    runtime,
    getPresentation: () => view,
    subscribePresentation: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    health: async () => "alive",
    dispose: async () => {
      listeners.clear();
    },
  };
  return {
    backend,
    publish(paneMap: Record<string, string>) {
      if (view.kind !== "tmux") {
        throw new Error("Expected terminal fixture");
      }
      view = { ...view, paneMap };
      for (const listener of listeners) {
        listener(view);
      }
    },
  };
}

const mixedCapabilities: BackendCapabilities = {
  panes: true,
  taskPanes: true,
  zoom: false,
  popups: false,
  rawInput: false,
  layout: false,
};
const terminalView: PresentationSnapshot = {
  kind: "tmux",
  tmuxSession: "personal",
  tmuxWindow: "private-window",
  tmuxSocket: null,
  originPane: "private-dashboard",
  managedTmux: false,
  paneMap: { api: "private/service:a", "@tui": "private-dashboard" },
  focusPane: "private/service:a",
};

function projectedSession(
  fixture: ReturnType<typeof presentationFixture>,
  backend: SessionBackend,
  extra: Partial<SessionCreateParams> = {},
) {
  return new Session(
    {
      configPath: fixture.config.configPath,
      projectDir: fixture.config.projectDir,
      config: fixture.config,
      deps: managerDependencies({}, fixture.deps),
      backend,
      shellEnv: {},
      env: {},
      ...extra,
    },
    fixture.manager,
  );
}

describe("Session backend presentation", () => {
  it("constructs, snapshots and disposes shell without tmux or terminal host fields", async () => {
    const fixture = presentationFixture({ api: { start: "true", detached: false } }, [
      {
        name: "api",
        state: "stopped",
        ports: [],
        retryCount: 0,
        paneId: "stale",
        isDetached: false,
      },
    ]);
    const tmux = await import("#src/lib/tmux.js");
    vi.mocked(tmux.tmuxFor).mockClear();
    const create = vi
      .spyOn(TmuxSessionBackend, "create")
      .mockRejectedValue(new Error("Unexpected tmux construction"));
    const backend = await ShellSessionBackend.create({ services: fixture.config.project.services });
    const session = projectedSession(fixture, backend);
    try {
      expect(session.backend).toBe(backend);
      const snapshot = session.attachSnapshot();
      expect(snapshot).toMatchObject({
        backend: "shell",
        paneMap: {},
        statuses: [
          {
            name: "api",
            isDetached: false,
            actions: { focus: false, zoom: false, editOutput: false },
          },
        ],
      });
      for (const field of [
        "tmuxSession",
        "tmuxWindow",
        "tmuxSocket",
        "managed",
        "managedTmux",
        "originPane",
        "tuiPane",
        "focusPane",
        "tmux",
      ]) {
        expect(snapshot).not.toHaveProperty(field);
        expect(session).not.toHaveProperty(field);
      }
      expect(snapshot.statuses[0]).not.toHaveProperty("paneId");
      expect(session.compatibilityProjection()).toEqual({ backend: "shell", paneMap: {} });
      const store = createMockStore();
      store.list = () => [session];
      const listed = await daemonHandlers["session.list"](
        { id: "shell-list", method: "session.list" },
        store,
      );
      expect(listed.result).toEqual([
        {
          id: session.id,
          name: session.name,
          configPath: session.configPath,
          projectDir: session.projectDir,
          createdAt: session.createdAt,
          backend: "shell",
          capabilities: session.backend.capabilities,
        },
      ]);
      expect(await backend.health()).toBe("alive");
      await session.reflowInsert("api");
      await session.reflowRemove("api");
    } finally {
      await session.destroy();
      expect(tmux.tmuxFor).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    }
    expect(await backend.health()).toBe("lost");
  });

  it("projects capabilities independently, current targets and copied lifecycle data", async () => {
    const status: ServiceStatus = {
      name: "api",
      state: "stopped",
      ports: [1234],
      retryCount: 2,
      paneId: "stale",
      startedAt: 10,
    };
    const fixture = presentationFixture(
      {
        api: { start: "true" },
        lazy: { start: "true", lazyPane: true },
        detached: { start: "true", detached: true },
      },
      [
        status,
        { ...status, name: "lazy" },
        { ...status, name: "detached" },
        { ...status, name: "unknown" },
      ],
    );
    const observed = observedBackend(fixture.runtime, mixedCapabilities, {
      ...terminalView,
      paneMap: { api: "private/service:a", detached: "stale-detached", unknown: "unknown-target" },
    });
    const session = projectedSession(fixture, observed.backend);
    try {
      const snapshot = session.attachSnapshot();
      expect(snapshot).toMatchObject({
        backend: "tmux",
        tmuxSession: "personal",
        managed: false,
        originPane: "private-dashboard",
      });
      expect(snapshot).not.toHaveProperty("focusPane");
      expect(session.compatibilityProjection().focusPane).toBe("private/service:a");
      expect(snapshot.statuses[0]).toMatchObject({
        state: "stopped",
        paneId: "private/service:a",
        actions: { focus: true, zoom: false, editOutput: false },
      });
      for (const projected of snapshot.statuses.slice(1)) {
        expect(projected.actions).toEqual({ focus: false, zoom: false, editOutput: false });
        expect(projected).not.toHaveProperty("paneId");
      }
      expect(status).toEqual({
        name: "api",
        state: "stopped",
        ports: [1234],
        retryCount: 2,
        paneId: "stale",
        startedAt: 10,
      });
      snapshot.statuses[0]?.ports.push(5678);
      snapshot.paneMap.api = "tampered";
      expect(status.ports).toEqual([1234]);
      expect(session.paneMap.api).toBe("private/service:a");
      expect(session.attachSnapshot().paneMap.api).toBe("private/service:a");
      fixture.config.unavailableServices.set("api", { name: "api", reason: "missing" });
      expect(session.projectStatus(status).actions).toEqual({
        focus: false,
        zoom: false,
        editOutput: false,
      });
    } finally {
      await session.destroy();
    }
  });

  it("requires pane capability before advertising zoom or popup actions", async () => {
    const status: ServiceStatus = { name: "api", state: "ready", ports: [], retryCount: 0 };
    const fixture = presentationFixture({ api: { start: "true" } }, [status]);
    const observed = observedBackend(
      fixture.runtime,
      {
        ...mixedCapabilities,
        panes: false,
        zoom: true,
        popups: true,
      },
      terminalView,
    );
    const session = projectedSession(fixture, observed.backend);
    try {
      expect(session.projectStatus(status).actions).toEqual({
        focus: false,
        zoom: false,
        editOutput: false,
      });
    } finally {
      await session.destroy();
    }
  });

  it("refreshes full unchanged lazy/shared statuses on target insertion, replacement and removal", async () => {
    const status: ServiceStatus = {
      name: "api",
      state: "stopped",
      ports: [3000],
      retryCount: 3,
      startedAt: 100,
      readySince: 200,
    };
    const fixture = presentationFixture(
      {
        api: { start: "true", lazyPane: true },
        owner: {
          start: "true",
          _combined: { group: "group", allServices: ["owner", "member"], isOwner: true },
        },
        member: {
          start: "true",
          _combined: { group: "group", allServices: ["owner", "member"], isOwner: false },
        },
      },
      [status, { ...status, name: "owner" }, { ...status, name: "member" }],
    );
    const observed = observedBackend(
      fixture.runtime,
      { ...mixedCapabilities, zoom: true, popups: true },
      { ...terminalView, paneMap: {} },
    );
    const title = vi
      .fn<NonNullable<PresentationDriver["updateTitle"]>>()
      .mockResolvedValue(undefined);
    observed.backend.presentation = {
      hasService: () => false,
      reload: vi.fn(),
      insert: vi.fn(),
      remove: vi.fn(),
      updateTitle: title,
    };
    const session = projectedSession(fixture, observed.backend);
    const sharedMap = session.paneMap;
    const broadcast = vi.spyOn(session, "broadcast");
    const managerEmit = vi.spyOn(fixture.manager, "emit");
    const loadedAt = session.configLoadedAt;
    try {
      const updates: Record<string, string>[] = [
        { api: "private/lazy:first", owner: "private/group:first" },
        { api: "private/lazy:second", owner: "private/group:second" },
        {},
      ];
      for (const paneMap of updates) {
        broadcast.mockClear();
        observed.publish(paneMap);
        expect(session.paneMap).toBe(sharedMap);
        expect(broadcast.mock.calls[0]?.[0]).toEqual({
          session: session.id,
          event: "session.paneMap",
          data: { paneMap },
        });
        expect(broadcast).toHaveBeenCalledTimes(4);
        for (const original of fixture.manager.getAllStatuses()) {
          const target = original.name === "api" ? paneMap.api : paneMap.owner;
          expect(broadcast).toHaveBeenCalledWith({
            session: session.id,
            event: "service.stateChange",
            data: {
              name: original.name,
              status: {
                ...original,
                ...(target ? { paneId: target } : {}),
                actions: {
                  focus: Boolean(target),
                  zoom: Boolean(target),
                  editOutput: Boolean(target),
                },
              },
            },
          });
        }
      }
      broadcast.mockClear();
      observed.publish({});
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(managerEmit).not.toHaveBeenCalled();
      expect(title).not.toHaveBeenCalled();
      expect(session.configLoadedAt).toBe(loadedAt);
      expect(status).toEqual({
        name: "api",
        state: "stopped",
        ports: [3000],
        retryCount: 3,
        startedAt: 100,
        readySince: 200,
      });
    } finally {
      await session.destroy();
    }
  });

  it("uses the same projection for lifecycle events and snapshots, preserving callback seams", async () => {
    const status: ServiceStatus = { name: "api", state: "ready", ports: [], retryCount: 0 };
    const fixture = presentationFixture({ api: { start: "true" } }, [status]);
    const observed = observedBackend(fixture.runtime, mixedCapabilities, terminalView);
    const insert = vi.fn<NonNullable<PresentationDriver["insert"]>>().mockResolvedValue(undefined);
    const remove = vi.fn<NonNullable<PresentationDriver["remove"]>>().mockResolvedValue(undefined);
    const title = vi
      .fn<NonNullable<PresentationDriver["updateTitle"]>>()
      .mockResolvedValue(undefined);
    observed.backend.presentation = {
      hasService: () => true,
      reload: vi.fn(),
      insert,
      remove,
      updateTitle: title,
    };
    const session = projectedSession(fixture, observed.backend);
    const broadcast = vi.spyOn(session, "broadcast");
    try {
      fixture.manager.emit("stateChange", "api", status);
      expect(broadcast).toHaveBeenCalledWith({
        session: session.id,
        event: "service.stateChange",
        data: { name: "api", status: session.attachSnapshot().statuses[0] },
      });
      expect(title).toHaveBeenCalledWith([status]);
      await session.reflowInsert("api");
      await session.reflowRemove("api");
      expect(insert).toHaveBeenCalledWith("api");
      expect(remove).toHaveBeenCalledWith("api");
    } finally {
      await session.destroy();
    }
  });
});

describe("Session presentation-independent logs", () => {
  it("retains distinct unit buffers across lazy insertion, replacement and removal", () => {
    const fixture = presentationFixture({ api: { start: "a" }, web: { start: "w" } }, []);
    const host = observedBackend(fixture.runtime, mixedCapabilities, terminalView);
    const session = projectedSession(fixture, host.backend);
    const api = session.logBuffers.get("api");
    const web = session.logBuffers.get("web");
    expect(web).not.toBe(api);
    fixture.manager.emit("logLines", "web", ["before"]);
    const presentations: Record<string, string>[] = [
      { api: "same", web: "same" },
      { api: "replacement", web: "replacement" },
      {},
    ];
    for (const paneMap of presentations) {
      host.publish(paneMap);
      expect(session.logBuffers.get("web")).toBe(web);
      expect(session.logBuffers.get("api")).toBe(api);
    }
    fixture.manager.emit("logLines", "api", ["api"]);
    fixture.manager.emit("logLines", "web", ["after"]);
    expect(session.attachSnapshot().logSnapshots).toEqual({
      api: ["api"],
      web: ["before", "after"],
    });
  });

  it("appends once for a stopped combined owner with a live sibling and no panes", () => {
    const fixture = presentationFixture(
      {
        a: { start: "a", _combined: { group: "g", allServices: ["a", "b"], isOwner: true } },
        b: { start: "b", _combined: { group: "g", allServices: ["a", "b"], isOwner: false } },
      },
      [
        { name: "a", state: "stopped", ports: [], retryCount: 0 },
        { name: "b", state: "ready", ports: [], retryCount: 0 },
      ],
    );
    const host = observedBackend(
      fixture.runtime,
      {
        panes: false,
        zoom: false,
        popups: false,
        taskPanes: false,
        rawInput: false,
        layout: false,
      },
      { kind: "shell" },
    );
    const session = projectedSession(fixture, host.backend);
    const broadcast = vi.spyOn(session, "broadcast");
    const buffer = session.logBuffers.get("a");
    if (!buffer) {
      throw new Error("Missing unit buffer");
    }
    const append = vi.spyOn(buffer, "appendLines");
    fixture.manager.emit("logLines", "a", ["live sibling"]);
    fixture.manager.emit("logLines", "b", ["live sibling"]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(session.logBuffers.get("b")).toBe(buffer);
    expect(session.attachSnapshot().logSnapshots).toEqual({
      a: ["live sibling"],
      b: ["live sibling"],
    });
    expect(broadcast.mock.calls.map(([event]) => event.data)).toEqual([
      { service: "a", lines: ["live sibling"] },
      { service: "b", lines: ["live sibling"] },
    ]);
  });
});
