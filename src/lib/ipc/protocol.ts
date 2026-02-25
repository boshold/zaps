export interface IpcRequest {
  id: string;
  method: string;
  session?: string;
  params?: unknown;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface IpcEvent {
  id: string;
  event: string;
  data?: unknown;
}

/**
 * Daemon-pushed event to subscribers (not tied to a request).
 */
export interface DaemonEvent {
  session: string;
  event: string;
  data?: unknown;
}

export type IpcMessage = IpcResponse | IpcEvent;

export function isIpcEvent(msg: IpcMessage): msg is IpcEvent {
  return "event" in msg;
}

export function isIpcResponse(msg: IpcMessage): msg is IpcResponse {
  return "result" in msg || "error" in msg;
}

export function isDaemonEvent(msg: unknown): msg is DaemonEvent {
  return typeof msg === "object" && msg !== null && "session" in msg && "event" in msg;
}
