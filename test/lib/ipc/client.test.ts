import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSocket: EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
};

vi.mock("node:net", () => ({
  default: {
    createConnection: vi.fn(() => {
      const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
      const socket = new EE() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        destroyed: boolean;
      };
      socket.write = vi.fn();
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
      });
      socket.destroyed = false;
      mockSocket = socket;
      return socket;
    }),
  },
}));

const { ipcRequest, ipcStream, ipcSubscribe } = await import("../../../src/lib/ipc/client.js");

describe("ipcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends request on connect and returns response", async () => {
    const promise = ipcRequest("/test.sock", "daemon.ping");

    // Simulate connect
    mockSocket.emit("connect");

    // Should have written request
    expect(mockSocket.write).toHaveBeenCalledTimes(1);
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));
    expect(req.method).toBe("daemon.ping");

    // Simulate response
    const response = JSON.stringify({ id: req.id, result: "pong" }) + "\n";
    mockSocket.emit("data", Buffer.from(response));

    const res = await promise;
    expect(res.result).toBe("pong");
  });

  it("times out after specified duration", async () => {
    const promise = ipcRequest("/test.sock", "test", undefined, 1000);
    mockSocket.emit("connect");

    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("rejects on socket error", async () => {
    const promise = ipcRequest("/test.sock", "test");
    mockSocket.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("includes session in request when provided", async () => {
    const promise = ipcRequest("/test.sock", "services.list", null, 30_000, "sess1");
    mockSocket.emit("connect");

    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));
    expect(req.session).toBe("sess1");

    const response = JSON.stringify({ id: req.id, result: [] }) + "\n";
    mockSocket.emit("data", Buffer.from(response));

    const res = await promise;
    expect(res.result).toEqual([]);
  });

  it("ignores messages with different ids", async () => {
    const promise = ipcRequest("/test.sock", "test");
    mockSocket.emit("connect");

    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Send response with wrong id
    mockSocket.emit("data", Buffer.from(JSON.stringify({ id: "other", result: "nope" }) + "\n"));
    // Then correct response
    mockSocket.emit("data", Buffer.from(JSON.stringify({ id: req.id, result: "yes" }) + "\n"));

    const res = await promise;
    expect(res.result).toBe("yes");
  });
});

describe("ipcStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls onEvent for events and resolves on response", async () => {
    const onEvent = vi.fn();
    const promise = ipcStream("/test.sock", "tasks.run", { key: "build" }, onEvent);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Send event
    mockSocket.emit(
      "data",
      Buffer.from(JSON.stringify({ id: req.id, event: "line", data: "output" }) + "\n"),
    );
    expect(onEvent).toHaveBeenCalledWith("line", "output");

    // Send final response
    mockSocket.emit(
      "data",
      Buffer.from(JSON.stringify({ id: req.id, result: { success: true } }) + "\n"),
    );

    const res = await promise;
    expect(res.result).toEqual({ success: true });
  });

  it("times out", async () => {
    const promise = ipcStream("/test.sock", "tasks.run", {}, vi.fn(), 500);
    mockSocket.emit("connect");

    vi.advanceTimersByTime(501);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("ignores events with different ids", async () => {
    const onEvent = vi.fn();
    const promise = ipcStream("/test.sock", "test", {}, onEvent);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Event with wrong id
    mockSocket.emit(
      "data",
      Buffer.from(JSON.stringify({ id: "other", event: "line", data: "x" }) + "\n"),
    );
    expect(onEvent).not.toHaveBeenCalled();

    // Correct response
    mockSocket.emit(
      "data",
      Buffer.from(JSON.stringify({ id: req.id, result: "done" }) + "\n"),
    );

    await promise;
  });
});

describe("ipcSubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes and receives daemon events", () => {
    const onEvent = vi.fn();
    const sub = ipcSubscribe("/test.sock", "sess1", ["log.*"], onEvent);

    mockSocket.emit("connect");

    // Should have sent subscribe request
    expect(mockSocket.write).toHaveBeenCalled();

    // Simulate daemon event
    mockSocket.emit(
      "data",
      Buffer.from(
        JSON.stringify({ session: "sess1", event: "log.lines", data: { lines: ["hi"] } }) + "\n",
      ),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ session: "sess1", event: "log.lines" }),
    );

    sub.close();
  });

  it("calls onClose when socket closes", () => {
    const onClose = vi.fn();
    ipcSubscribe("/test.sock", "s1", [], vi.fn(), onClose);

    mockSocket.emit("connect");
    mockSocket.emit("close");

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on error", () => {
    const onClose = vi.fn();
    ipcSubscribe("/test.sock", "s1", [], vi.fn(), onClose);

    mockSocket.emit("error", new Error("ENOENT"));
    expect(onClose).toHaveBeenCalled();
  });

  it("connected getter reflects state", () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    expect(sub.connected).toBe(false);

    mockSocket.emit("connect");
    expect(sub.connected).toBe(true);

    mockSocket.emit("close");
    expect(sub.connected).toBe(false);

    sub.close();
  });

  it("send is no-op when disconnected", () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    sub.send("test"); // Should not throw
    expect(mockSocket.write).not.toHaveBeenCalled();
    sub.close();
  });

  it("request rejects when disconnected", async () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    await expect(sub.request("test")).rejects.toThrow("Not connected");
    sub.close();
  });

  it("request resolves on matching response", async () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.list");

    // Find the request id from the write call
    const calls = mockSocket.write.mock.calls;
    const lastCall = JSON.parse((calls[calls.length - 1][0] as string).replace("\n", ""));

    // Simulate response
    mockSocket.emit(
      "data",
      Buffer.from(JSON.stringify({ id: lastCall.id, result: ["api"] }) + "\n"),
    );

    const res = await reqPromise;
    expect(res.result).toEqual(["api"]);

    sub.close();
  });

  it("handles malformed JSON gracefully", () => {
    const onEvent = vi.fn();
    ipcSubscribe("/test.sock", "s1", [], onEvent);
    mockSocket.emit("connect");

    // Should not throw
    mockSocket.emit("data", Buffer.from("not-json\n"));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
