import { z } from "zod";

import type { SessionStore } from "#src/daemon/server.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { sentraTemplateFor } from "#src/lib/sentra/config.js";
import { clearSession, listErrors, listIssues, showById } from "#src/lib/sentra/query.js";
import type { SentraQuerySource } from "#src/lib/sentra/query.js";
import {
  clearParamsSchema,
  errorsParamsSchema,
  issuesParamsSchema,
  showParamsSchema,
  statusParamsSchema,
} from "#src/lib/sentra/schemas.js";
import type { StatusResult } from "#src/lib/sentra/schemas.js";
import { SentraQueryError } from "#src/lib/sentra/time.js";

type Handler = (req: IpcRequest, store: SessionStore) => Promise<IpcResponse>;

const DISABLED_MESSAGE =
  'sentra_disabled: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.';

/** `null` when the session is not running (the enabled check is skipped then). */
function sessionEnabled(store: SessionStore, sessionId: string): boolean | null {
  const session = store.get(sessionId);
  if (!session) {
    return null;
  }
  const { sentra } = session.config.project;
  return sentra !== undefined && sentra.enabled !== false;
}

function optedInServices(store: SessionStore, sessionId: string): string[] {
  const project = store.get(sessionId)?.config.project;
  if (!project) {
    return [];
  }
  return Object.entries(project.services)
    .filter(([, service]) => sentraTemplateFor(project.sentra, service.sentra) !== null)
    .map(([name]) => name);
}

function errorText(error: unknown): string {
  if (error instanceof SentraQueryError) {
    return error.toString();
  }
  return error instanceof Error ? error.message : String(error);
}

/** Parses params, checks enabled, starts Sentra lazily, then runs `run`. */
function queryHandler<S extends z.ZodType<{ sessionId: string }>>(
  schema: S,
  run: (sentra: SentraQuerySource, params: z.infer<S>) => Promise<unknown>,
): Handler {
  return async (req, store) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      return ipcErr(req.id, `invalid_filter: ${z.prettifyError(parsed.error)}`);
    }
    if (sessionEnabled(store, parsed.data.sessionId) === false) {
      return ipcErr(req.id, DISABLED_MESSAGE);
    }
    const sentra = await store.sentra.ensureStarted();
    if (!sentra) {
      const reason = store.sentra.status().reason ?? "unknown error";
      return ipcErr(req.id, `sentra_unavailable: ${reason}`);
    }
    try {
      return ipcOk(req.id, await run(sentra, parsed.data));
    } catch (error) {
      return ipcErr(req.id, errorText(error));
    }
  };
}

export const sentraHandlers: Record<string, Handler> = {
  async "sentra.status"(req, store) {
    const parsed = statusParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return ipcErr(req.id, `invalid_filter: ${z.prettifyError(parsed.error)}`);
    }
    const { sessionId } = parsed.data;
    const enabled = sessionEnabled(store, sessionId);
    if (enabled !== false) {
      await store.sentra.ensureStarted();
    }
    const host = store.sentra.status();
    const result: StatusResult = {
      enabled,
      state: enabled === false ? "disabled" : host.state,
      port: host.port,
      dbPath: host.dbPath,
      reason: host.reason,
      services: optedInServices(store, sessionId),
    };
    return ipcOk(req.id, result);
  },

  "sentra.errors": queryHandler(errorsParamsSchema, listErrors),
  "sentra.issues": queryHandler(issuesParamsSchema, listIssues),
  "sentra.show": queryHandler(showParamsSchema, async (sentra, params) =>
    showById(sentra, params.sessionId, params.id),
  ),
  "sentra.clear": queryHandler(clearParamsSchema, clearSession),
};
