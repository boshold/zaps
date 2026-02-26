import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:net", () => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  class MockServer extends EE {
    listen = vi.fn((_path: string, cb: () => void) => {
      setTimeout(cb, 0);
    });
    close = vi.fn();
  }

  return {
    default: {
      createServer: vi.fn(() => new MockServer()),
    },
  };
});

vi.mock("node:fs", () => ({
  default: {
    unlinkSync: vi.fn(),
  },
}));

vi.mock("../../../src/lib/ipc/handler.js", () => ({
  handleRequest: vi.fn().mockResolvedValue({ id: "r1", result: "ok" }),
}));

const { IpcServer } = await import("../../../src/lib/ipc/server.js");
const { handleRequest } = (await import("../../../src/lib/ipc/handler.js")) as {
  handleRequest: ReturnType<typeof vi.fn>;
};

describe("IpcServer", () => {
  let server: InstanceType<typeof IpcServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new IpcServer("/test.sock", {} as never, {} as never);
  });

  afterEach(() => {
    server.stop();
    vi.restoreAllMocks();
  });

  it("starts and listens", async () => {
    await server.start();
    const net = (await import("node:net")).default;
    const mockServer = vi.mocked(net.createServer).mock.results[0].value;
    expect(mockServer.listen).toHaveBeenCalledWith("/test.sock", expect.any(Function));
  });

  it("cleans up stale socket on start", async () => {
    await server.start();
    const fs = (await import("node:fs")).default;
    expect(fs.unlinkSync).toHaveBeenCalledWith("/test.sock");
  });

  it("stops cleanly", async () => {
    await server.start();
    server.stop();
    const fs = (await import("node:fs")).default;
    // unlinkSync called on start + stop
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it("stop is safe when not started", () => {
    expect(() => server.stop()).not.toThrow();
  });

  it("handles incoming JSON lines", async () => {
    await server.start();
    const net = (await import("node:net")).default;
    const mockServer = vi.mocked(net.createServer).mock.results[0].value;
    const connectionHandler = vi.mocked(net.createServer).mock.calls[0][0] as (
      socket: EventEmitter,
    ) => void;

    const socket = new EventEmitter();
    (socket as Record<string, unknown>)["write"] = vi.fn();
    connectionHandler(socket);

    const req = JSON.stringify({ id: "r1", method: "ping" }) + "\n";
    socket.emit("data", Buffer.from(req));

    await new Promise((r) => setTimeout(r, 50));

    expect(handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", method: "ping" }),
      expect.anything(),
      expect.anything(),
      socket,
    );

    const write = (socket as Record<string, ReturnType<typeof vi.fn>>)["write"];
    expect(write).toHaveBeenCalled();
  });

  it("handles invalid JSON", async () => {
    await server.start();
    const net = (await import("node:net")).default;
    const connectionHandler = vi.mocked(net.createServer).mock.calls[0][0] as (
      socket: EventEmitter,
    ) => void;

    const socket = new EventEmitter();
    (socket as Record<string, unknown>)["write"] = vi.fn();
    connectionHandler(socket);

    socket.emit("data", Buffer.from("bad json\n"));

    await new Promise((r) => setTimeout(r, 50));

    const write = (socket as Record<string, ReturnType<typeof vi.fn>>)["write"];
    expect(write).toHaveBeenCalled();
    const response = JSON.parse((write.mock.calls[0][0] as string).replace("\n", ""));
    expect(response.error).toContain("Invalid JSON");
  });

  it("ignores empty lines", async () => {
    await server.start();
    const net = (await import("node:net")).default;
    const connectionHandler = vi.mocked(net.createServer).mock.calls[0][0] as (
      socket: EventEmitter,
    ) => void;

    const socket = new EventEmitter();
    (socket as Record<string, unknown>)["write"] = vi.fn();
    connectionHandler(socket);

    socket.emit("data", Buffer.from("\n\n"));

    await new Promise((r) => setTimeout(r, 50));
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("handles socket errors gracefully", async () => {
    await server.start();
    const net = (await import("node:net")).default;
    const connectionHandler = vi.mocked(net.createServer).mock.calls[0][0] as (
      socket: EventEmitter,
    ) => void;

    const socket = new EventEmitter();
    (socket as Record<string, unknown>)["write"] = vi.fn();
    connectionHandler(socket);

    // Should not throw
    expect(() => socket.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});
