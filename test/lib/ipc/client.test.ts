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
      // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
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
    const response = `${JSON.stringify({ id: req.id, result: "pong" })}\n`;
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

    const response = `${JSON.stringify({ id: req.id, result: [] })}\n`;
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
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: "other", result: "nope" })}\n`));
    // Then correct response
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "yes" })}\n`));

    const res = await promise;
    expect(res.result).toBe("yes");
  });

  it("omits params when params is null", async () => {
    const promise = ipcRequest("/test.sock", "test", null);
    mockSocket.emit("connect");

    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));
    expect(req).not.toHaveProperty("params");

    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "ok" })}\n`));
    await promise;
  });

  it("skips empty lines in buffer", async () => {
    const promise = ipcRequest("/test.sock", "test");
    mockSocket.emit("connect");

    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Send empty line followed by response
    mockSocket.emit("data", Buffer.from(`\n${JSON.stringify({ id: req.id, result: "ok" })}\n`));

    const res = await promise;
    expect(res.result).toBe("ok");
  });

  it("rejects immediately when the socket closes before a response (E5)", async () => {
    const promise = ipcRequest("/test.sock", "test");
    mockSocket.emit("connect");
    mockSocket.emit("close");

    await expect(promise).rejects.toThrow("daemon connection closed");
  });

  it("survives a malformed JSON line and processes a later valid line (E5)", async () => {
    const promise = ipcRequest("/test.sock", "test");
    mockSocket.emit("connect");

    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Garbage line must not crash the client; the next valid line resolves.
    mockSocket.emit("data", Buffer.from("not-json{{{\n"));
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "ok" })}\n`));

    const res = await promise;
    expect(res.result).toBe("ok");
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
      Buffer.from(`${JSON.stringify({ id: req.id, event: "line", data: "output" })}\n`),
    );
    expect(onEvent).toHaveBeenCalledWith("line", "output");

    // Send final response
    mockSocket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ id: req.id, result: { success: true } })}\n`),
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
      Buffer.from(`${JSON.stringify({ id: "other", event: "line", data: "x" })}\n`),
    );
    expect(onEvent).not.toHaveBeenCalled();

    // Correct response
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "done" })}\n`));

    await promise;
  });

  it("rejects on socket error", async () => {
    const promise = ipcStream("/test.sock", "test", {}, vi.fn());
    mockSocket.emit("error", new Error("ECONNRESET"));

    await expect(promise).rejects.toThrow("ECONNRESET");
  });

  it("skips empty lines in buffer", async () => {
    const onEvent = vi.fn();
    const promise = ipcStream("/test.sock", "test", {}, onEvent);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Empty line followed by response
    mockSocket.emit("data", Buffer.from(`\n${JSON.stringify({ id: req.id, result: "ok" })}\n`));

    const res = await promise;
    expect(res.result).toBe("ok");
  });

  it("ignores messages that are neither event nor response", async () => {
    const onEvent = vi.fn();
    const promise = ipcStream("/test.sock", "test", {}, onEvent);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Send message with matching id but neither event nor result
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, something: "else" })}\n`));
    expect(onEvent).not.toHaveBeenCalled();

    // Then send valid response
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "done" })}\n`));
    const res = await promise;
    expect(res.result).toBe("done");
  });

  it("does not time out while events keep arriving (inactivity reset, E3)", async () => {
    const onEvent = vi.fn();
    const promise = ipcStream("/test.sock", "tasks.run", {}, onEvent, 500);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // Emit an event every 300ms (< the 500ms window) for well past the window.
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(300);
      mockSocket.emit(
        "data",
        Buffer.from(`${JSON.stringify({ id: req.id, event: "line", data: i })}\n`),
      );
    }
    // 1800ms elapsed, but never 500ms of silence — the stream is still alive.
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: req.id, result: "done" })}\n`));

    const res = await promise;
    expect(res.result).toBe("done");
    expect(onEvent).toHaveBeenCalledTimes(6);
  });

  it("times out after the inactivity window of silence (E3)", async () => {
    const promise = ipcStream("/test.sock", "tasks.run", {}, vi.fn(), 500);

    mockSocket.emit("connect");
    const written = mockSocket.write.mock.calls[0][0] as string;
    const req = JSON.parse(written.replace("\n", ""));

    // One event, then silence past the window → inactivity timeout.
    mockSocket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ id: req.id, event: "line", data: 1 })}\n`),
    );
    vi.advanceTimersByTime(501);

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("rejects immediately when the socket closes mid-stream (E5)", async () => {
    const promise = ipcStream("/test.sock", "tasks.run", {}, vi.fn());
    mockSocket.emit("connect");
    mockSocket.emit("close");

    await expect(promise).rejects.toThrow("daemon connection closed");
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
        `${JSON.stringify({ session: "sess1", event: "log.lines", data: { lines: ["hi"] } })}\n`,
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
    const { calls } = mockSocket.write.mock;
    const lastCall = JSON.parse((calls[calls.length - 1][0] as string).replace("\n", ""));

    // Simulate response
    mockSocket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ id: lastCall.id, result: ["api"] })}\n`),
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

  it("request times out after 30s", async () => {
    vi.useFakeTimers();
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.list");
    vi.advanceTimersByTime(30_001);

    await expect(reqPromise).rejects.toThrow("Request timed out");

    sub.close();
    vi.useRealTimers();
  });

  it("send works when connected", () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");
    sub.send("session.detach");
    // Subscribe request + send = 2 writes
    expect(mockSocket.write).toHaveBeenCalledTimes(2);
    sub.close();
  });

  it("close event without onClose callback does not throw", () => {
    // IpcSubscribe called without onClose
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");
    mockSocket.emit("close"); // Should not throw
    sub.close();
  });

  it("error event without onClose callback does not throw", () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("error", new Error("oops")); // Should not throw
    sub.close();
  });

  it("request skips empty lines in response data", async () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.list");

    const { calls } = mockSocket.write.mock;
    const lastCall = JSON.parse((calls[calls.length - 1][0] as string).replace("\n", ""));

    // Send empty line + response
    mockSocket.emit(
      "data",
      Buffer.from(`\n${JSON.stringify({ id: lastCall.id, result: ["api"] })}\n`),
    );

    const res = await reqPromise;
    expect(res.result).toEqual(["api"]);
    sub.close();
  });

  it("skips empty lines in subscription data", () => {
    const onEvent = vi.fn();
    ipcSubscribe("/test.sock", "s1", [], onEvent);
    mockSocket.emit("connect");

    // Empty line + daemon event
    mockSocket.emit(
      "data",
      Buffer.from(
        `\n${JSON.stringify({ session: "s1", event: "log.lines", data: { lines: ["x"] } })}\n`,
      ),
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("invokes onError on a daemon error-ack (E8)", () => {
    const onError = vi.fn();
    ipcSubscribe("/test.sock", "s1", [], vi.fn(), undefined, onError);
    mockSocket.emit("connect");

    // The daemon replies to the subscribe request with an error ack.
    const subReq = JSON.parse((mockSocket.write.mock.calls[0][0] as string).replace("\n", ""));
    mockSocket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ id: subReq.id, error: "Unknown session" })}\n`),
    );

    expect(onError).toHaveBeenCalledWith("Unknown session");
  });

  it("rejects a pending request when the socket closes (E5)", async () => {
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.list");
    mockSocket.emit("close");

    await expect(reqPromise).rejects.toThrow("daemon connection closed");
  });

  it("demuxes a request response while events stream on the same socket (E5)", async () => {
    const onEvent = vi.fn();
    const sub = ipcSubscribe("/test.sock", "s1", [], onEvent);
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.list");
    const { calls } = mockSocket.write.mock;
    const reqId = JSON.parse((calls[calls.length - 1][0] as string).replace("\n", "")).id;

    // A daemon event interleaves before the request's own response.
    mockSocket.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ session: "s1", event: "log.lines", data: { lines: ["x"] } })}\n`,
      ),
    );
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: reqId, result: ["api"] })}\n`));

    const res = await reqPromise;
    expect(res.result).toEqual(["api"]);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "log.lines" }));
    sub.close();
  });

  it("request with timeoutMs=0 has no wall-clock timeout (inactivity-bounded use)", async () => {
    vi.useFakeTimers();
    const sub = ipcSubscribe("/test.sock", "s1", [], vi.fn());
    mockSocket.emit("connect");

    const reqPromise = sub.request("services.startAll", undefined, 0);
    vi.advanceTimersByTime(300_000); // 5 minutes — would have tripped a fixed timeout

    const { calls } = mockSocket.write.mock;
    const reqId = JSON.parse((calls[calls.length - 1][0] as string).replace("\n", "")).id;
    mockSocket.emit("data", Buffer.from(`${JSON.stringify({ id: reqId, result: "ok" })}\n`));

    await expect(reqPromise).resolves.toMatchObject({ result: "ok" });
    sub.close();
    vi.useRealTimers();
  });
});
