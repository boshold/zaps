import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ConfigError } from "../../src/config/errors.js";

// eslint-disable-next-line no-unsafe-type-assertion -- Test boundary
vi.mock("node:net", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  class MockServer extends EE {
    // eslint-disable-next-line prefer-await-to-callbacks -- vi.mock callback pattern
    public listen = vi.fn((_path: string, cb: () => void) => {
      setTimeout(cb, 0);
    });
    public close = vi.fn();
  }

  class MockSocket extends EE {
    public write = vi.fn();
    public destroy = vi.fn();
    public destroyed = false;
  }

  return {
    default: {
      createServer: vi.fn((handler: (socket: unknown) => void) => {
        const server = new MockServer();
        (server as unknown as Record<string, unknown>)._connectionHandler = handler;
        return server;
      }),
      createConnection: vi.fn(() => new MockSocket()),
    },
  };
});

vi.mock("node:fs", () => ({
  default: {
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => "12345"),
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
  },
}));

vi.mock("#src/config/loader.js", () => ({
  loadConfig: vi.fn(),
  // P04-T03: computeBootSkip is called by buildSession before createLayout.
  // Empty set → no boot-skips (matches every existing test's expectation).
  computeBootSkip: vi.fn(() => new Set<string>()),
}));

const loaderModule = await import("#src/config/loader.js");
const mockLoadConfig = vi.mocked(loaderModule.loadConfig);

vi.mock("#src/lib/tmux-layout.js", () => ({
  createLayout: vi.fn(),
}));

vi.mock("#src/lib/tmux.js", () => {
  // Server + Session bind handles via `tmuxFor(tmuxSocket)`; the factory returns
  // The SAME stub surface for both the module exports and the handle, so
  // Assertions on the named exports still observe every call.
  let socket: string | null = null;
  const api = {
    getSocket: () => socket,
    hasSession: vi.fn().mockResolvedValue(true),
    killSession: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn(),
    selectPane: vi.fn(),
    sendKeys: vi.fn(),
    sendCtrlC: vi.fn(),
    panePid: vi.fn(),
    paneExists: vi.fn(),
    killPane: vi.fn(),
    renameWindow: vi.fn(),
    getWindowName: vi.fn(),
    getWindowOption: vi.fn(),
    setWindowOption: vi.fn(),
    displayMessage: vi.fn(),
    displayPopup: vi.fn(),
    resyncPaneSizes: vi.fn(),
    // LayoutReflow (constructed by Session) uses these too.
    getWindowSize: vi.fn().mockResolvedValue({ width: 100, height: 30 }),
    paneIndexOrder: vi.fn().mockResolvedValue([]),
    selectLayout: vi.fn().mockResolvedValue(undefined),
    splitPane: vi.fn().mockResolvedValue("%99"),
    swapPanes: vi.fn().mockResolvedValue(undefined),
    windowLayout: vi.fn().mockResolvedValue("prior-layout-string"),
  };
  return {
    ...api,
    tmuxFor: vi.fn((value: string | null) => {
      socket = value;
      return api;
    }),
  };
});

vi.mock("#src/lib/port.js", () => ({
  detectPorts: vi.fn(),
  detectPortsForPid: vi.fn(),
  getDescendantPids: vi.fn(),
}));

const layoutModule = await import("#src/lib/tmux-layout.js");
const mockCreateLayout = vi.mocked(layoutModule.createLayout);
const tmux = vi.mocked(await import("#src/lib/tmux.js"));

vi.mock("#src/lib/service/manager.js", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires, unicorn/prefer-module -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  class MockServiceManager extends EE {
    public disposeObservers = vi.fn();
    public resumeRuntimeObserver = vi.fn();
    public startAll = vi.fn().mockResolvedValue(undefined);
    public stopAll = vi.fn().mockResolvedValue(undefined);
    public abortStartAll = vi.fn();
    public startService = vi.fn().mockResolvedValue(undefined);
    public stopService = vi.fn().mockResolvedValue(undefined);
    public restartService = vi.fn().mockResolvedValue(undefined);
    public getAllStatuses = vi.fn(() => []);
    public getStatus = vi.fn();
  }
  return { ServiceManager: MockServiceManager };
});

const { TmuxTerminalOperations } = await import("#src/lib/backend/tmux/operations.js");
const { TmuxTerminalDriver } = await import("#src/lib/backend/tmux/driver.js");
const { TmuxRuntime } = await import("#src/lib/backend/tmux/runtime.js");
const { DaemonServer } = await import("../../src/daemon/server.js");
const { SentraHost } = await import("../../src/lib/sentra/host.js");
const { sentraEnvFor } = await import("../../src/lib/sentra/config.js");

describe("DaemonServer", () => {
  let server: InstanceType<typeof DaemonServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
      project: { name: "test", services: { api: { start: "npm dev" } } },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
    } as never);
    mockCreateLayout.mockResolvedValue({
      paneMap: { "@tui": "%0", api: "%1" },
      focusPane: "%0",
    });
    tmux.selectPane.mockResolvedValue(undefined);
    tmux.capturePane.mockResolvedValue("");
    tmux.sendKeys.mockResolvedValue(undefined);
    tmux.sendCtrlC.mockResolvedValue(undefined);
    tmux.panePid.mockResolvedValue(1000);
    tmux.paneExists.mockResolvedValue(true);
    tmux.killPane.mockResolvedValue(undefined);
    tmux.renameWindow.mockResolvedValue(undefined);
    tmux.getWindowName.mockResolvedValue("bash");
    tmux.getWindowOption.mockResolvedValue("on");
    tmux.setWindowOption.mockResolvedValue(undefined);
    tmux.displayMessage.mockImplementation(async (_target, format) =>
      format === "#{pane_dead}" ? "0" : "@1",
    );
    server = new DaemonServer();
  });

  afterEach(() => {
    server.stop();
    vi.restoreAllMocks();
  });

  it("tracks autostart once and never restarts on reuse, list or snapshots", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };
    const session = await server.create(params);
    await session.startPromise;
    expect(session.manager.startAll).toHaveBeenCalledTimes(1);
    await session.manager.stopAll();
    expect(await server.create(params)).toBe(session);
    server.list();
    session.config.unavailableServices = new Map();
    session.attachSnapshot();
    expect(session.manager.startAll).toHaveBeenCalledTimes(1);
  });

  it("cleans presentation after a post-layout construction failure", async () => {
    tmux.getWindowName.mockRejectedValueOnce(new Error("snapshot failed"));
    await expect(
      server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      }),
    ).rejects.toThrow("snapshot failed");
    expect(tmux.killPane).toHaveBeenCalledWith("%1");
    expect(tmux.killPane).not.toHaveBeenCalledWith("%0");
    expect(server.sessionCount).toBe(0);
  });

  it("starts and listens on socket path", async () => {
    await server.start("/tmp/test.sock");
    expect(server.sessionCount).toBe(0);
  });

  it("stops cleanly", async () => {
    await server.start("/tmp/test.sock");
    server.stop();
    // Should not throw on double stop
    server.stop();
  });

  it("lists sessions (empty)", () => {
    expect(server.list()).toEqual([]);
  });

  it("returns undefined for unknown session", () => {
    expect(server.get("unknown")).toBeUndefined();
  });

  it("returns undefined for unknown projectDir", () => {
    expect(server.getByProjectDir("/nonexistent")).toBeUndefined();
  });

  it("finds session by projectDir", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(server.getByProjectDir("/test")).toBe(session);
  });

  it("passes the shared sentra host and session scope into manager deps", async () => {
    const sentraHost = new SentraHost({
      dbPath: ":memory:",
      portStatePath: "/nonexistent/sentra.json",
    });
    const log = vi.fn();
    const scoped = new DaemonServer({ sentraHost, log });
    mockLoadConfig.mockResolvedValueOnce({
      project: { name: "my app/v2", services: { api: { start: "npm dev" } } },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
    } as never);

    const session = await scoped.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });

    expect(scoped.sentra).toBe(sentraHost);
    expect(session.deps.sentra).toEqual({
      host: sentraHost,
      project: "my-app-v2",
      session: session.id,
      projectDir: "/test",
      log,
      onEnvBuilt: expect.any(Function),
      onServiceStart: expect.any(Function),
    });
    scoped.stop();
  });

  it("derives the sentra project segment from the current config name", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(session.deps.sentra?.project).toBe("test");
    session.config = {
      ...session.config,
      project: { ...session.config.project, name: "new name" },
    };
    expect(session.deps.sentra?.project).toBe("new-name");
  });

  it("wires env builds and service starts into the error counter, detaches on destroy", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    const attach = vi.spyOn(server.sentraCounter, "attach").mockImplementation((_id, broadcast) => {
      broadcast({ session: session.id, event: "sentra.item", data: null });
    });
    const broadcast = vi.spyOn(session, "broadcast");
    const detach = vi.spyOn(server.sentraCounter, "detach");

    session.deps.sentra?.onServiceStart?.("api", 1234);
    expect(attach).not.toHaveBeenCalled();
    session.deps.sentra?.onEnvBuilt?.();

    expect(attach).toHaveBeenCalledWith(session.id, expect.any(Function));
    expect(broadcast).toHaveBeenCalledWith({
      session: session.id,
      event: "sentra.item",
      data: null,
    });
    expect(server.sentraCounter.get(session.id, "api")).toBe(0);

    await server.destroy(session.id);
    expect(detach).toHaveBeenCalledWith(session.id);
    expect(server.sentraCounter.get(session.id, "api")).toBeNull();
  });

  it("attaches for task-only Sentra configs and broadcasts their records", async () => {
    mockLoadConfig.mockResolvedValueOnce({
      project: {
        name: "test",
        services: { api: { start: "npm dev" } },
        tasks: { e2e: { name: "E2E", commands: "pnpm e2e", sentra: { env: { DSN: "{dsn}" } } } },
      },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
    } as never);
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    vi.spyOn(server.sentra, "ensureStarted").mockResolvedValue({} as never);
    vi.spyOn(server.sentra, "getDsn").mockReturnValue("http://sentra@127.0.0.1:1/p/s/e2e/1");
    vi.spyOn(server.sentra, "addSourceRoot").mockImplementation(() => undefined);
    const subscribe = vi.spyOn(server.sentra, "subscribe").mockImplementation((_filter, fn) => {
      fn({ type: "envelope.failed", error: "boom", envelope: {} as never });
      return () => undefined;
    });
    const broadcast = vi.spyOn(session, "broadcast");

    const env = await sentraEnvFor(
      session.deps.sentra,
      undefined,
      { env: { DSN: "{dsn}" } },
      "e2e",
    );

    expect(env).toEqual({ DSN: "http://sentra@127.0.0.1:1/p/s/e2e/1" });
    expect(subscribe).toHaveBeenCalledWith({ session: session.id }, expect.any(Function));
    expect(broadcast).toHaveBeenCalledWith({
      session: session.id,
      event: "sentra.failed",
      data: { error: "boom" },
    });
  });

  it("detaches even when session teardown throws", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    vi.spyOn(session, "destroy").mockRejectedValue(new Error("teardown failed"));
    const detach = vi.spyOn(server.sentraCounter, "detach");
    await expect(server.destroy(session.id)).rejects.toThrow("teardown failed");
    expect(detach).toHaveBeenCalledWith(session.id);
  });

  it("logs when subscribing fails", async () => {
    const log = vi.fn();
    const scoped = new DaemonServer({ log });
    const session = await scoped.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });

    session.deps.sentra?.onEnvBuilt?.();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("cannot subscribe session"));
    scoped.stop();
  });

  it("creates a default sentra host when none is passed", () => {
    expect(server.sentra).toBeInstanceOf(SentraHost);
  });

  it("creates session and stores it", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(session.id).toBeDefined();
    expect(session.tmuxWindow).toBe("@1");
    expect(tmux.displayMessage).toHaveBeenCalledWith("%0", "#{window_id}");
    expect(server.sessionCount).toBe(1);
    expect(server.get(session.id)).toBe(session);
  });

  it("binds the layout + session handle to the requested tmux socket", async () => {
    const { tmuxFor } = await import("#src/lib/tmux.js");
    vi.mocked(tmuxFor).mockClear();

    const session = await server.create({
      configPath: "/socket/.zaps.mts",
      projectDir: "/socket",
      tmuxSession: "zaps-socket-abc",
      originPane: "%0",
      tmuxSocket: "zaps",
      managedTmux: true,
    });

    expect(tmuxFor).toHaveBeenCalledWith("zaps");
    expect(session.tmuxSocket).toBe("zaps");
    expect(session.managedTmux).toBe(true);
    const layoutCall = mockCreateLayout.mock.calls.at(-1);
    expect(layoutCall?.[4]).toMatchObject({ tmux: expect.any(Object) });
  });

  it("defaults an unmanaged session to the user's default server", async () => {
    const { tmuxFor } = await import("#src/lib/tmux.js");
    vi.mocked(tmuxFor).mockClear();

    const session = await server.create({
      configPath: "/default/.zaps.mts",
      projectDir: "/default",
      tmuxSession: "main",
      originPane: "%0",
    });

    expect(tmuxFor).toHaveBeenCalledWith(null);
    expect(session.tmuxSocket).toBeNull();
    expect(session.managedTmux).toBe(false);
  });

  it("returns existing session on duplicate create", async () => {
    const s1 = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    const s2 = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(s1).toBe(s2);
    expect(server.sessionCount).toBe(1);
  });

  it("dedupes concurrent creates for the same id into one build (D3)", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };
    const [s1, s2] = await Promise.all([server.create(params), server.create(params)]);

    expect(s1).toBe(s2);
    expect(server.sessionCount).toBe(1);
    // Exactly one config load + one layout build for the shared promise.
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateLayout).toHaveBeenCalledTimes(1);
  });

  it("leaves no session registered when the config throws a ConfigError", async () => {
    mockLoadConfig.mockRejectedValueOnce(
      new ConfigError("invalid config", { kind: "validation", field: "services" }),
    );
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };

    await expect(server.create(params)).rejects.toBeInstanceOf(ConfigError);
    expect(server.sessionCount).toBe(0);
  });

  it("clears the in-flight entry on failure so a retry rebuilds (D3)", async () => {
    mockLoadConfig.mockRejectedValueOnce(new Error("load boom"));
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };

    await expect(server.create(params)).rejects.toThrow("load boom");
    expect(server.sessionCount).toBe(0);

    // Entry was removed on rejection → the retry proceeds with the default mock.
    const session = await server.create(params);
    expect(session.id).toBeDefined();
    expect(server.sessionCount).toBe(1);
  });

  it("returns the cached session when its @tui pane is still alive (A4)", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };
    const s1 = await server.create(params);
    tmux.paneExists.mockResolvedValue(true);

    const s2 = await server.create(params);
    expect(s2).toBe(s1);
    // No rebuild on a live cache hit.
    expect(mockCreateLayout).toHaveBeenCalledTimes(1);
  });

  it("refuses a create whose tmux context disagrees with the live session", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };
    await server.create(params);
    tmux.paneExists.mockResolvedValue(true);

    // Same project, but this caller runs in a managed tmux: handing back the
    // Session on the default server would drive tmux at the wrong one.
    await expect(
      server.create({ ...params, tmuxSocket: "zaps", managedTmux: true }),
    ).rejects.toThrow(/Session already running on the default tmux server/u);
    expect(server.sessionCount).toBe(1);
  });

  it("still reuses the session for an identical tmux context", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "zaps-test-abc",
      originPane: "%0",
      tmuxSocket: "zaps",
      managedTmux: true,
    };
    const s1 = await server.create(params);
    tmux.paneExists.mockResolvedValue(true);
    await expect(server.create({ ...params, originPane: "%9" })).resolves.toBe(s1);
    expect(s1.originPane).toBe("%0");
    expect(s1.tmuxWindow).toBe("@1");
    expect(tmux.displayMessage).toHaveBeenCalledTimes(2);
  });

  it("destroys and rebuilds when the cached @tui pane is dead (A4)", async () => {
    const params = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    };
    const s1 = await server.create(params);
    expect(server.sessionCount).toBe(1);

    // The window was closed externally — next create rebuilds with the new pane.
    tmux.paneExists.mockResolvedValue(false);
    tmux.displayMessage.mockResolvedValueOnce("@9");
    const s2 = await server.create({ ...params, originPane: "%9" });

    expect(s2).not.toBe(s1);
    expect(s1.destroyed).toBe(true);
    expect(s2.originPane).toBe("%9");
    expect(s2.tmuxWindow).toBe("@9");
    expect(server.sessionCount).toBe(1);
    expect(mockCreateLayout).toHaveBeenCalledTimes(2);
  });

  it("exposes the layout focusPane on the created session (E14)", async () => {
    mockCreateLayout.mockResolvedValueOnce({
      paneMap: { "@tui": "%0", api: "%1" },
      focusPane: "%1",
    });
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(session.focusPane).toBe("%1");
  });

  it("fires onSessionChange callback", async () => {
    const callback = vi.fn();
    server.onSessionChange = callback;
    await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(callback).toHaveBeenCalledWith(1);
  });

  it("destroys session and cleans up", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    await server.destroy(session.id);
    expect(server.sessionCount).toBe(0);
    expect(server.get(session.id)).toBeUndefined();
  });

  it("attempts every backend disposer and preserves synchronous and asynchronous failures", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    const operationsFailure = new Error("operations cleanup failed");
    const terminalFailure = new Error("terminal cleanup failed");
    const runtimeFailure = new Error("runtime cleanup failed");
    const operations = vi
      .spyOn(TmuxTerminalOperations.prototype, "dispose")
      .mockImplementationOnce(() => {
        throw operationsFailure;
      });
    const terminal = vi
      .spyOn(TmuxTerminalDriver.prototype, "dispose")
      .mockRejectedValueOnce(terminalFailure);
    const runtime = vi.spyOn(TmuxRuntime.prototype, "dispose").mockImplementationOnce(() => {
      throw runtimeFailure;
    });
    await expect(session.backend.dispose()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ errors: [operationsFailure, terminalFailure, runtimeFailure] }),
      ],
    });
    expect(operations).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(runtime).toHaveBeenCalledTimes(1);
  });

  it("destroy is no-op for unknown session", async () => {
    await expect(server.destroy("unknown")).resolves.toBeUndefined();
  });

  describe("request routing", () => {
    it.each(["close", "error"])(
      "ACKs subscriptions before binding and revokes on %s",
      async (event) => {
        await server.start("/tmp/test.sock");
        const session = await server.create({
          configPath: "/test/.zaps.mts",
          projectDir: "/test",
          tmuxSession: "main",
          originPane: "%0",
        });
        session.config.unavailableServices = new Map();
        const { default: net } = await import("node:net");
        const mockServer = vi.mocked(net.createServer).mock.results[0].value;
        const listener = z
          .custom<(socket: Socket) => void>((value) => typeof value === "function")
          .parse(mockServer._connectionHandler);
        const socket = net.createConnection("/tmp/test.sock");
        const callbacks: (() => void)[] = [];
        const responses: string[] = [];
        // eslint-disable-next-line prefer-await-to-callbacks -- test controls socket flush
        const write = vi.fn((line: string, flushed?: (failure?: Error | null) => void) => {
          responses.push(line);
          if (flushed) {
            callbacks.push(() => flushed());
          }
          return true;
        });
        Object.assign(socket, { writable: true, destroyed: false, write });
        listener(socket);
        const send = (id: string, method: string, params?: unknown) =>
          socket.emit(
            "data",
            Buffer.from(`${JSON.stringify({ id, method, session: session.id, params })}\n`),
          );
        send("subscribe", "subscribe", { events: [] });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
        send("early", "session.attach", { ui: true });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
        expect(responses[1]).toContain("invalid_request");
        callbacks[0]();
        socket.emit(
          "data",
          Buffer.from(
            [
              JSON.stringify({
                id: "attach",
                method: "session.attach",
                session: session.id,
                params: { ui: true },
              }),
              JSON.stringify({
                id: "before-attach-ack",
                method: "terminal.action",
                session: session.id,
                params: { action: "taskPicker" },
              }),
              "",
            ].join("\n"),
          ),
        );
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(4));
        expect(session.getUiBinding(socket)).toMatchObject({
          socket,
          sessionId: session.id,
          acknowledged: false,
        });

        expect(responses[3]).toContain("invalid_request");
        const oldAttachAcknowledgement = callbacks.at(2);
        session.bindUi(socket);
        oldAttachAcknowledgement?.();
        expect(session.getUiBinding(socket)?.acknowledged).toBe(false);
        send("stale-attach-ack", "terminal.action", { action: "taskPicker" });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(5));
        expect(responses[4]).toContain("invalid_request");
        send("fresh-attach", "session.attach", { ui: true });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(6));
        callbacks[5]();
        const { terminal } = session.backend;
        if (!terminal) {
          throw new Error("Expected terminal driver");
        }
        vi.spyOn(terminal, "taskPicker").mockResolvedValueOnce(null);
        send("after-attach-ack", "terminal.action", { action: "taskPicker" });
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(7));
        expect(responses[6]).toContain('"taskKey":null');
        expect(socket.listenerCount("close")).toBe(1);
        socket.emit(event, new Error("connection lost"));
        expect(session.getUiBinding(socket)).toBeUndefined();
        expect(session.subscribers.has(socket)).toBe(false);
        callbacks[0]();
        expect(() => session.bindUi(socket)).toThrow("invalid_request");
        server.stop();
      },
    );

    it.each(["detach", "close", "error", "resubscribe"])(
      "never lets an old subscribe ACK authorize a replacement after %s",
      async (removal) => {
        await server.start("/tmp/test.sock");
        const session = await server.create({
          configPath: "/test/.zaps.mts",
          projectDir: "/test",
          tmuxSession: "main",
          originPane: "%0",
        });
        session.config.unavailableServices = new Map();
        session.config.unavailableServices = new Map();
        const { default: net } = await import("node:net");
        const mockServer = vi.mocked(net.createServer).mock.results[0].value;
        const listener = z
          .custom<(socket: Socket) => void>((value) => typeof value === "function")
          .parse(mockServer._connectionHandler);
        const socket = net.createConnection("/tmp/test.sock");
        const callbacks: (() => void)[] = [];
        const responses: string[] = [];
        // eslint-disable-next-line prefer-await-to-callbacks -- test controls socket flush
        const write = vi.fn((line: string, flushed?: (failure?: Error | null) => void) => {
          responses.push(line);
          if (flushed) {
            callbacks.push(() => flushed());
          }
          return true;
        });
        Object.assign(socket, { writable: true, destroyed: false, write });
        listener(socket);
        const request = async (method: string, params?: unknown) => {
          const count = responses.length + 1;
          socket.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ id: String(count), method, session: session.id, params })}\n`,
            ),
          );
          await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(count));
          return responses[count - 1];
        };
        await request("subscribe", { events: [] });
        const [acknowledgeOld] = callbacks;
        if (removal === "detach") {
          await request("session.detach");
        } else if (removal !== "resubscribe") {
          socket.emit(removal, new Error("connection lost"));
        }
        await request("subscribe", { events: [] });
        const acknowledgeReplacement = callbacks.at(-1);
        const early = await request("session.attach", { ui: true });
        expect(early).toContain("invalid_request");
        acknowledgeOld();
        const stale = await request("session.attach", { ui: true });
        expect(stale).toContain("invalid_request");
        expect(session.getUiBinding(socket)).toBeUndefined();
        acknowledgeReplacement?.();
        const accepted = await request("session.attach", { ui: true });
        expect(accepted).not.toContain("error");
        expect(session.getUiBinding(socket)).toMatchObject({ socket, sessionId: session.id });
        session.removeSubscriber(socket);
        server.stop();
      },
    );

    it("handles daemon.ping", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "p1", method: "daemon.ping" })}\n`;
      socket.emit("data", Buffer.from(req));

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(write).toHaveBeenCalled();
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response).toEqual({ id: "p1", result: "pong" });
    });

    it("handles invalid JSON", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      socket.emit("data", Buffer.from("not json\n"));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(write).toHaveBeenCalled();
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toContain("Invalid JSON");
    });

    it("returns error for unknown method", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "u1", method: "unknown.method" })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toContain("Unknown method");
    });

    it('handles backward-compat bare "ping"', async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "bp1", method: "ping" })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response).toEqual({ id: "bp1", result: "pong" });
    });

    it("requires session for session-scoped handlers", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "s1", method: "services.list" })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toContain("Session required");
    });

    it("socket error cleans up subscribers", async () => {
      await server.start("/tmp/test.sock");
      const session = await server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      });

      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      // Add socket as subscriber
      session.subscribers.add(socket as never);
      expect(session.subscribers.has(socket as never)).toBe(true);

      // Emit error to trigger cleanup
      socket.emit("error", new Error("ECONNRESET"));
      expect(session.subscribers.has(socket as never)).toBe(false);
    });

    it("handles multi-chunk JSON buffering", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      // Split the JSON across two data events
      const fullReq = `${JSON.stringify({ id: "mc1", method: "daemon.ping" })}\n`;
      const half = Math.floor(fullReq.length / 2);
      socket.emit("data", Buffer.from(fullReq.slice(0, half)));
      socket.emit("data", Buffer.from(fullReq.slice(half)));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(write).toHaveBeenCalled();
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response).toEqual({ id: "mc1", result: "pong" });
    });

    it("skips empty lines in buffered data", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      // Send data with empty lines between valid JSON
      const req = JSON.stringify({ id: "el1", method: "daemon.ping" });
      socket.emit("data", Buffer.from(`\n\n${req}\n\n`));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      // Should only handle the valid JSON line, not empty ones
      expect(write).toHaveBeenCalledTimes(1);
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response).toEqual({ id: "el1", result: "pong" });
    });

    it("fires onSessionChange on destroy", async () => {
      const callback = vi.fn();
      server.onSessionChange = callback;
      const session = await server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      });
      expect(callback).toHaveBeenCalledWith(1);
      callback.mockClear();

      await server.destroy(session.id);
      expect(callback).toHaveBeenCalledWith(0);
    });

    it("catches session handler errors", async () => {
      await server.start("/tmp/test.sock");

      // Create a session first
      const session = await server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      });

      // Make the handler throw
      vi.mocked(session.manager.getAllStatuses).mockImplementation(() => {
        throw new Error("session handler error");
      });

      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "se1", method: "services.list", session: session.id })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(write).toHaveBeenCalled();
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toContain("session handler error");
    });

    it("catches non-Error in session handler", async () => {
      await server.start("/tmp/test.sock");
      const session = await server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      });

      vi.mocked(session.manager.getAllStatuses).mockImplementation(() => {
        throw "string error"; // eslint-disable-line no-throw-literal
      });

      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "sne1", method: "services.list", session: session.id })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toBe("string error");
    });

    it("catches non-Error thrown in daemon handler", async () => {
      await server.start("/tmp/test.sock");

      vi.spyOn(server, "list").mockImplementation(() => {
        throw "daemon string error"; // eslint-disable-line no-throw-literal
      });

      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "dne1", method: "daemon.status" })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toBe("daemon string error");
    });

    it("destroy completes when an already-gone pane rejects killing", async () => {
      tmux.killPane.mockRejectedValue(new Error("pane already dead"));
      tmux.paneExists.mockResolvedValue(false);

      const session = await server.create({
        configPath: "/test/.zaps.mts",
        projectDir: "/test",
        tmuxSession: "main",
        originPane: "%0",
      });

      await expect(server.destroy(session.id)).resolves.toBeUndefined();
      expect(server.sessionCount).toBe(0);
    });

    it("catches daemon handler errors", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = Object.assign(new EventEmitter(), { writable: true });
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      // Daemon.sessions.create will throw because of invalid params
      const req = `${JSON.stringify({ id: "de1", method: "daemon.sessions.create", params: {} })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(write).toHaveBeenCalled();
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toBeDefined();
    });
  });
});
