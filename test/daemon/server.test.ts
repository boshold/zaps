import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
}));

const loaderModule = await import("#src/config/loader.js");
const mockLoadConfig = vi.mocked(loaderModule.loadConfig);

vi.mock("#src/lib/tmux-layout.js", () => ({
  createLayout: vi.fn(),
}));

vi.mock("#src/lib/tmux.js", () => ({
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
  resyncPaneSizes: vi.fn(),
}));

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

const { DaemonServer } = await import("../../src/daemon/server.js");

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
    server = new DaemonServer();
  });

  afterEach(() => {
    server.stop();
    vi.restoreAllMocks();
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

  it("creates session and stores it", async () => {
    const session = await server.create({
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      tmuxSession: "main",
      originPane: "%0",
    });
    expect(session.id).toBeDefined();
    expect(server.sessionCount).toBe(1);
    expect(server.get(session.id)).toBe(session);
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
    const s2 = await server.create({ ...params, originPane: "%9" });

    expect(s2).not.toBe(s1);
    expect(s1.destroyed).toBe(true);
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

  it("destroy is no-op for unknown session", async () => {
    await expect(server.destroy("unknown")).resolves.toBeUndefined();
  });

  describe("request routing", () => {
    it("handles daemon.ping", async () => {
      await server.start("/tmp/test.sock");
      const netModule = await import("node:net");
      const net = netModule.default;
      const mockServer = vi.mocked(net.createServer).mock.results[0].value;
      const handler = mockServer._connectionHandler as (socket: EventEmitter) => void;

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
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

      const socket = new EventEmitter();
      (socket as unknown as Record<string, unknown>).write = vi.fn();
      handler(socket);

      const req = `${JSON.stringify({ id: "dne1", method: "daemon.status" })}\n`;
      socket.emit("data", Buffer.from(req));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { write } = socket as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const response = JSON.parse(write.mock.calls[0][0].replace("\n", ""));
      expect(response.error).toBe("daemon string error");
    });

    it("destroy completes when killPane rejects", async () => {
      tmux.killPane.mockRejectedValue(new Error("pane already dead"));

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

      const socket = new EventEmitter();
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
