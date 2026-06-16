import net from "node:net";

import type { DaemonEvent, IpcMessage, IpcRequest, IpcResponse } from "./protocol.js";
import { isDaemonEvent, isIpcEvent, isIpcResponse } from "./protocol.js";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Guarded ndjson parse — a malformed line yields `undefined`, never throws (E5). */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    // Skip a malformed line rather than crashing the whole client process.
    return undefined;
  }
}

/** Narrow a parsed socket value to a request-correlated message (has an `id`). */
function asMessage(value: unknown): IpcMessage | null {
  if (typeof value === "object" && value !== null && "id" in value) {
    return value as IpcMessage;
  }
  return null;
}

/**
 * Build a `data` handler with its own line buffer: accumulates chunks, splits on
 * newlines, guards every parse, and forwards each decoded value. One handler per
 * socket keeps a single source of truth for line framing (no second buffer that
 * can start mid-JSON-line, E5).
 */
function makeLineHandler(onValue: (value: unknown) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer): void => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      const value = parseLine(line);
      if (value !== undefined) {
        onValue(value);
      }
    }
  };
}

export async function ipcRequest(
  socketPath: string,
  method: string,
  params?: unknown,
  timeout = 30_000,
  session?: string,
): Promise<IpcResponse> {
  const id = generateId();
  const req: IpcRequest = {
    id,
    method,
    ...(params !== null && { params }),
    ...(session && { session }),
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const state: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const finish = (action: () => void): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
      socket.destroy();
      action();
    };
    state.timer = setTimeout(() => {
      finish(() => reject(new Error(`IPC request timed out after ${timeout}ms`)));
    }, timeout);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    socket.on(
      "data",
      makeLineHandler((value) => {
        const msg = asMessage(value);
        if (msg && isIpcResponse(msg) && msg.id === id) {
          finish(() => resolve(msg));
        }
      }),
    );

    // A clean FIN fires no `error`; without this the promise hangs the full
    // Timeout. Reject pending work immediately when the daemon goes away (E5).
    socket.on("close", () => {
      finish(() => reject(new Error("daemon connection closed")));
    });

    socket.on("error", (e) => {
      finish(() => reject(e));
    });
  });
}

export async function ipcStream(
  socketPath: string,
  method: string,
  params: unknown,
  onEvent: (event: string, data: unknown) => void,
  timeout = 120_000,
  session?: string,
): Promise<IpcResponse> {
  const id = generateId();
  const req: IpcRequest = { id, method, params, ...(session && { session }) };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const state: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const finish = (action: () => void): void => {
      if (state.settled) {
        return;
      }
      state.settled = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
      socket.destroy();
      action();
    };
    // Inactivity timeout: re-armed on every received event, so a stream that
    // Keeps emitting never times out; only `timeout`ms of silence aborts (E3).
    const arm = (): void => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        finish(() => reject(new Error(`IPC stream timed out after ${timeout}ms of inactivity`)));
      }, timeout);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    socket.on(
      "data",
      makeLineHandler((value) => {
        const msg = asMessage(value);
        if (!msg || msg.id !== id) {
          return;
        }
        if (isIpcEvent(msg)) {
          arm();
          onEvent(msg.event, msg.data);
        } else if (isIpcResponse(msg)) {
          finish(() => resolve(msg));
        }
      }),
    );

    socket.on("close", () => {
      finish(() => reject(new Error("daemon connection closed")));
    });

    socket.on("error", (e) => {
      finish(() => reject(e));
    });

    arm();
  });
}

/**
 * Persistent connection that subscribes to daemon events.
 * Returns a handle to send requests and close the connection.
 */
export function ipcSubscribe(
  socketPath: string,
  session: string,
  events: string[],
  onEvent: (event: DaemonEvent) => void,
  onClose?: () => void,
  onError?: (error: string) => void,
): IpcSubscription {
  const socket = net.createConnection(socketPath);
  let connected = false;
  const subscribeId = generateId();

  interface Pending {
    resolve: (res: IpcResponse) => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();

  const rejectAllPending = (err: Error): void => {
    for (const [id, p] of pending) {
      if (p.timer) {
        clearTimeout(p.timer);
      }
      pending.delete(id);
      p.reject(err);
    }
  };

  // Resolves once the socket connects; also resolves on close/error so a caller
  // Awaiting readiness never hangs (a follow-up request then rejects cleanly).
  let resolveReady: (() => void) | undefined = undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  socket.on("connect", () => {
    connected = true;
    const req: IpcRequest = {
      id: subscribeId,
      method: "subscribe",
      session,
      params: { events },
    };
    socket.write(`${JSON.stringify(req)}\n`);
    resolveReady?.();
  });

  socket.on(
    "data",
    makeLineHandler((value) => {
      if (isDaemonEvent(value)) {
        onEvent(value);
        return;
      }
      const msg = asMessage(value);
      if (!msg || !isIpcResponse(msg)) {
        return;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        // Demux a `request()` response through the single data handler (E5).
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        pending.delete(msg.id);
        waiter.resolve(msg);
        return;
      }
      // An unmatched error response is a daemon error-ack (e.g. the subscribe
      // Ack for "Unknown session") — surface it instead of dropping it (E8).
      if (msg.error !== undefined) {
        onError?.(msg.error);
      }
    }),
  );

  socket.on("close", () => {
    connected = false;
    resolveReady?.();
    rejectAllPending(new Error("daemon connection closed"));
    onClose?.();
  });

  socket.on("error", (e) => {
    connected = false;
    resolveReady?.();
    rejectAllPending(e instanceof Error ? e : new Error(String(e)));
    onClose?.();
  });

  return {
    ready,
    send(method: string, params?: unknown): void {
      if (!connected) {
        return;
      }
      const req: IpcRequest = { id: generateId(), method, session, params };
      socket.write(`${JSON.stringify(req)}\n`);
    },
    async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<IpcResponse> {
      const id = generateId();
      const req: IpcRequest = { id, method, session, params };
      return new Promise((resolve, reject) => {
        if (!connected) {
          reject(new Error("Not connected"));
          return;
        }
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error("Request timed out"));
              }, timeoutMs)
            : undefined;
        pending.set(id, { resolve, reject, timer });
        socket.write(`${JSON.stringify(req)}\n`);
      });
    },
    close(): void {
      socket.destroy();
    },
    get connected(): boolean {
      return connected;
    },
  };
}

export interface IpcSubscription {
  /** Resolves when the socket connects (or settles on close) — never rejects. */
  readonly ready: Promise<void>;
  send(method: string, params?: unknown): void;
  /** `timeoutMs <= 0` disables the per-request timeout (inactivity-bounded use). */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<IpcResponse>;
  close(): void;
  readonly connected: boolean;
}
