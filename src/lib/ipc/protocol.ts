export interface IpcRequest {
  id: string;
  method: string;
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

export type IpcMessage = IpcResponse | IpcEvent;

export function isIpcEvent(msg: IpcMessage): msg is IpcEvent {
  return "event" in msg;
}

export function isIpcResponse(msg: IpcMessage): msg is IpcResponse {
  return "result" in msg || "error" in msg;
}
