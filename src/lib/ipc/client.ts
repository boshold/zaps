import net from "node:net";

import type { IpcMessage, IpcRequest, IpcResponse } from "./protocol.js";
import { isIpcEvent, isIpcResponse } from "./protocol.js";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function ipcRequest(
  socketPath: string,
  method: string,
  params?: unknown,
  timeout = 30_000,
): Promise<IpcResponse> {
  const id = generateId();
  const req: IpcRequest = { id, method, ...(params !== undefined && { params }) };

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
        if (line.trim() === "") continue;
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
): Promise<IpcResponse> {
  const id = generateId();
  const req: IpcRequest = { id, method, params };

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
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as IpcMessage;
        if (msg.id !== id) continue;

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
