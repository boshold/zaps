import net from "node:net";

import type { DaemonEvent, IpcMessage, IpcRequest, IpcResponse } from "./protocol.js";

import { isDaemonEvent, isIpcEvent, isIpcResponse } from "./protocol.js";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
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
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC request timed out after ${timeout}ms`));
    }, timeout);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        const msg = JSON.parse(line) as IpcMessage;
        if (isIpcResponse(msg) && msg.id === id) {
          clearTimeout(timer);
          socket.destroy();
          resolve(msg);
          return;
        }
      }
    });

    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
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
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC stream timed out after ${timeout}ms`));
    }, timeout);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        const msg = JSON.parse(line) as IpcMessage;
        if (msg.id !== id) {
          continue;
        }

        if (isIpcEvent(msg)) {
          onEvent(msg.event, msg.data);
        } else if (isIpcResponse(msg)) {
          clearTimeout(timer);
          socket.destroy();
          resolve(msg);
          return;
        }
      }
    });

    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
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
): IpcSubscription {
  const socket = net.createConnection(socketPath);
  let buffer = "";
  let connected = false;

  socket.on("connect", () => {
    connected = true;
    const req: IpcRequest = {
      id: generateId(),
      method: "subscribe",
      session,
      params: { events },
    };
    socket.write(`${JSON.stringify(req)}\n`);
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const msg: unknown = JSON.parse(line);
        if (isDaemonEvent(msg)) {
          onEvent(msg);
        }
        // IpcResponse to subscribe request — ignore (ack)
      } catch {
        /* Malformed message — skip */
      }
    }
  });

  socket.on("close", () => {
    connected = false;
    onClose?.();
  });

  socket.on("error", () => {
    connected = false;
    onClose?.();
  });

  return {
    send(method: string, params?: unknown): void {
      if (!connected) {
        return;
      }
      const req: IpcRequest = { id: generateId(), method, session, params };
      socket.write(`${JSON.stringify(req)}\n`);
    },
    async request(method: string, params?: unknown): Promise<IpcResponse> {
      const id = generateId();
      const req: IpcRequest = { id, method, session, params };
      return new Promise((resolve, reject) => {
        if (!connected) {
          reject(new Error("Not connected"));
          return;
        }

        const timer = setTimeout(() => {
          reject(new Error("Request timed out"));
        }, 30_000);

        let reqBuffer = "";
        function onData(chunk: Buffer) {
          reqBuffer += chunk.toString();
          const dataLines = reqBuffer.split("\n");
          reqBuffer = dataLines.pop() ?? "";

          for (const dataLine of dataLines) {
            if (dataLine.trim() === "") {
              continue;
            }
            const responseMsg = JSON.parse(dataLine) as IpcMessage;
            if (isIpcResponse(responseMsg) && responseMsg.id === id) {
              clearTimeout(timer);
              socket.off("data", onData);
              resolve(responseMsg);
              return;
            }
          }
        }

        socket.on("data", onData);
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
  send(method: string, params?: unknown): void;
  request(method: string, params?: unknown): Promise<IpcResponse>;
  close(): void;
  readonly connected: boolean;
}
