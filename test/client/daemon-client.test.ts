import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIpcRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcStream = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcSubscribe = vi.fn();

vi.mock("../../src/lib/ipc/client.js", () => ({
  ipcRequest: async (...args: unknown[]) => mockIpcRequest(...args),
  ipcStream: async (...args: unknown[]) => mockIpcStream(...args),
  ipcSubscribe: (...args: unknown[]) => mockIpcSubscribe(...args),
}));

const { DaemonClient } = await import("../../src/client/daemon-client.js");

describe("DaemonClient", () => {
  let client: InstanceType<typeof DaemonClient>;
  let mockSub: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    connected: boolean;
  };
  let eventHandler: (event: unknown) => void;
  let closeHandler: () => void;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSub = {
      send: vi.fn(),
      close: vi.fn(),
      request: vi.fn(),
      connected: true,
    };

    mockIpcSubscribe.mockImplementation(
      (
        _sock: string,
        _session: string,
        _events: string[],
        onEvent: (event: unknown) => void,
        onClose?: () => void,
      ) => {
        eventHandler = onEvent;
        closeHandler =
          onClose ??
          (() => {
            /* Noop */
          });
        return mockSub;
      },
    );

    client = new DaemonClient("/test.sock", "sess1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects via ipcSubscribe", () => {
    client.connect();
    expect(mockIpcSubscribe).toHaveBeenCalledWith(
      "/test.sock",
      "sess1",
      expect.any(Array),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("reports connected state", () => {
    expect(client.connected).toBe(false);
    client.connect();
    expect(client.connected).toBe(true);
  });

  it("returns session id", () => {
    expect(client.session).toBe("sess1");
  });

  it("disconnect sends detach and closes", () => {
    client.connect();
    client.disconnect();
    expect(mockSub.send).toHaveBeenCalledWith("session.detach");
    expect(mockSub.close).toHaveBeenCalled();
  });

  it("disconnect is safe when not connected", () => {
    expect(() => client.disconnect()).not.toThrow();
  });

  it("emits disconnect on close", () => {
    const spy = vi.fn();
    client.on("disconnect", spy);
    client.connect();
    closeHandler();
    expect(spy).toHaveBeenCalled();
  });

  describe("request methods", () => {
    beforeEach(() => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: "ok" });
    });

    it("attach returns snapshot", async () => {
      const snapshot = { id: "sess1", statuses: [] };
      mockIpcRequest.mockResolvedValue({ id: "r1", result: snapshot });
      const result = await client.attach();
      expect(result).toEqual(snapshot);
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.attach",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("attach throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Unknown session" });
      await expect(client.attach()).rejects.toThrow("Unknown session");
    });

    it("reloadConfig", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { reloaded: true } });
      await client.reloadConfig();
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.reload",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("reloadConfig throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Config invalid" });
      await expect(client.reloadConfig()).rejects.toThrow("Config invalid");
    });

    it("destroySession", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { destroyed: true } });
      await client.destroySession();
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.destroy",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("destroySession throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "fail" });
      await expect(client.destroySession()).rejects.toThrow("fail");
    });

    it("listServices", async () => {
      const statuses = [{ name: "api", state: "ready" }];
      mockIpcRequest.mockResolvedValue({ id: "r1", result: statuses });
      const result = await client.listServices();
      expect(result).toEqual(statuses);
    });

    it("startService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { started: "api" } });
      await client.startService("api");
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "services.start",
        { name: "api" },
        30_000,
        "sess1",
      );
    });

    it("stopService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { stopped: "api" } });
      await client.stopService("api");
    });

    it("restartService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: "api" } });
      await client.restartService("api");
    });

    it("restartAll", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: "all" } });
      await client.restartAll();
    });

    it("getLogSnapshot", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: ["line1", "line2"] });
      const result = await client.getLogSnapshot("api");
      expect(result).toEqual(["line1", "line2"]);
    });

    it("listServices throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "list fail" });
      await expect(client.listServices()).rejects.toThrow("list fail");
    });

    it("stopService throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "stop fail" });
      await expect(client.stopService("api")).rejects.toThrow("stop fail");
    });

    it("restartService throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "restart fail" });
      await expect(client.restartService("api")).rejects.toThrow("restart fail");
    });

    it("restartAll throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "restartAll fail" });
      await expect(client.restartAll()).rejects.toThrow("restartAll fail");
    });

    it("getLogSnapshot throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "log fail" });
      await expect(client.getLogSnapshot("api")).rejects.toThrow("log fail");
    });
  });

  describe("runTask", () => {
    it("streams task output", async () => {
      mockIpcStream.mockImplementation(
        async (_sock: unknown, _method: unknown, _params: unknown, onEvent: unknown) => {
          const emit = onEvent as (event: string, data: unknown) => void;
          emit("line", "output1");
          emit("progress", { key: "sub", result: "success" });
          return { id: "r1", result: { success: true } };
        },
      );

      const onLine = vi.fn();
      const onProgress = vi.fn();
      const result = await client.runTask("build", { onLine, onProgress });

      expect(result).toEqual({ success: true });
      expect(onLine).toHaveBeenCalledWith("output1");
      expect(onProgress).toHaveBeenCalledWith("sub", "success");
    });

    it("throws on error response", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", error: "task error" });
      await expect(client.runTask("bad", {})).rejects.toThrow("task error");
    });
  });

  describe("event routing", () => {
    it("routes service.stateChange", () => {
      const spy = vi.fn();
      client.on("service.stateChange", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "service.stateChange",
        data: { name: "api", status: { state: "ready" } },
      });

      expect(spy).toHaveBeenCalledWith("api", { state: "ready" });
    });

    it("routes log.lines", () => {
      const spy = vi.fn();
      client.on("log.lines", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "log.lines",
        data: { service: "api", lines: ["hi"] },
      });

      expect(spy).toHaveBeenCalledWith("api", ["hi"]);
    });

    it("routes task.start", () => {
      const spy = vi.fn();
      client.on("task.start", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "task.start",
        data: { key: "build", name: "Build" },
      });

      expect(spy).toHaveBeenCalledWith("build", "Build");
    });

    it("routes task.complete", () => {
      const spy = vi.fn();
      client.on("task.complete", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "task.complete",
        data: { key: "build", name: "Build", result: "success" },
      });

      expect(spy).toHaveBeenCalledWith("build", "Build", "success");
    });

    it("routes session.destroyed", () => {
      const spy = vi.fn();
      client.on("session.destroyed", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "session.destroyed",
        data: null,
      });

      expect(spy).toHaveBeenCalled();
    });

    it("routes session.configReloaded", () => {
      const spy = vi.fn();
      client.on("session.configReloaded", spy);
      client.connect();

      const snapshot = { id: "sess1", name: "test", statuses: [] };
      eventHandler({
        session: "sess1",
        event: "session.configReloaded",
        data: snapshot,
      });

      expect(spy).toHaveBeenCalledWith(snapshot);
    });

    it("ignores unknown events", () => {
      client.connect();
      // Should not throw
      eventHandler({
        session: "sess1",
        event: "unknown.event",
        data: {},
      });
    });
  });
});
