import { z } from "zod";

import type { ConfigNotice } from "#src/config/types.js";
import { backendErrorCodeSchema } from "#src/lib/backend/schemas.js";
import type { BackendErrorCode } from "#src/lib/backend/schemas.js";
import type { RequestContext } from "#src/lib/request-context.js";

/** Payload of the `log.lines` daemon event. */
export const logLinesDataSchema = z.object({ service: z.string(), lines: z.array(z.string()) });

export interface IpcRequest {
  id: string;
  method: string;
  session?: string;
  params?: unknown;
  context?: RequestContext;
}

/** Payload of the `config.notice` daemon event (cli.warn/info/success). */
export type ConfigNoticeData = ConfigNotice;

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: string;
  errorCode?: BackendErrorCode;
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

export function ipcOk(id: string, result: unknown): IpcResponse {
  return { id, result };
}

export function ipcErr(id: string, error: unknown, code?: BackendErrorCode): IpcResponse {
  const parsed = backendErrorCodeSchema.safeParse(
    code ??
      (typeof error === "object" && error !== null && "code" in error ? error.code : undefined),
  );
  return {
    id,
    error: error instanceof Error ? error.message : String(error),
    ...(parsed.success ? { errorCode: parsed.data } : {}),
  };
}
