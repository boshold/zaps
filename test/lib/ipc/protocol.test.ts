import { describe, expect, it } from "vitest";

import {
  ipcErr,
  ipcOk,
  isDaemonEvent,
  isIpcEvent,
  isIpcResponse,
} from "../../../src/lib/ipc/protocol.js";
import type { IpcEvent, IpcMessage, IpcResponse } from "../../../src/lib/ipc/protocol.js";

describe("isIpcEvent", () => {
  it("returns true for event messages", () => {
    const msg: IpcEvent = { id: "1", event: "stateChange", data: {} };
    expect(isIpcEvent(msg)).toBe(true);
  });

  it("returns false for response messages", () => {
    const msg: IpcResponse = { id: "1", result: "ok" };
    expect(isIpcEvent(msg)).toBe(false);
  });

  it("returns false for error responses", () => {
    const msg: IpcResponse = { id: "1", error: "fail" };
    expect(isIpcEvent(msg)).toBe(false);
  });
});

describe("isIpcResponse", () => {
  it("returns true for result responses", () => {
    const msg: IpcResponse = { id: "1", result: "ok" };
    expect(isIpcResponse(msg)).toBe(true);
  });

  it("returns true for error responses", () => {
    const msg: IpcResponse = { id: "1", error: "fail" };
    expect(isIpcResponse(msg)).toBe(true);
  });

  it("returns false for event messages", () => {
    const msg: IpcMessage = { id: "1", event: "test" };
    expect(isIpcResponse(msg)).toBe(false);
  });
});

describe("isDaemonEvent", () => {
  it("returns true for daemon events", () => {
    expect(isDaemonEvent({ session: "s1", event: "stateChange" })).toBe(true);
  });

  it("returns true with data field", () => {
    expect(isDaemonEvent({ session: "s1", event: "log.lines", data: [] })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isDaemonEvent(null)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isDaemonEvent("string")).toBe(false);
    expect(isDaemonEvent(42)).toBe(false);
    expect(isDaemonEvent(undefined)).toBe(false);
  });

  it("returns false when missing session", () => {
    expect(isDaemonEvent({ event: "test" })).toBe(false);
  });

  it("returns false when missing event", () => {
    expect(isDaemonEvent({ session: "s1" })).toBe(false);
  });
});

describe("ipcOk", () => {
  it("creates success response", () => {
    const res = ipcOk("req1", "pong");
    expect(res).toEqual({ id: "req1", result: "pong" });
  });

  it("handles complex result", () => {
    const res = ipcOk("req2", { pid: 123, sessions: [] });
    expect(res.id).toBe("req2");
    expect(res.result).toEqual({ pid: 123, sessions: [] });
  });
});

describe("ipcErr", () => {
  it("creates error response", () => {
    const res = ipcErr("req1", "something failed");
    expect(res).toEqual({ id: "req1", error: "something failed" });
  });
});
