import { z } from "zod";

import { sentraHandlers } from "#src/daemon/handlers/sentra.js";
import { logConfigError } from "#src/daemon/log-config-error.js";
import type { SessionStore } from "#src/daemon/server.js";
import { runShutdownHook } from "#src/daemon/shutdown.js";
import { supportedBackends } from "#src/lib/backend/factory.js";
import {
  backendIdSchema,
  normalizeLegacySessionCreateParams,
  sessionCreatedSchema,
  sessionListEntrySchema,
} from "#src/lib/backend/schemas.js";
import { daemonStatusSchema } from "#src/lib/backend/wire.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { captureEnvironment, parseRequestContext } from "#src/lib/request-context.js";

/** A tmux socket name is a non-empty, non-blank string (used verbatim for `-L`). */
function isSocketName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export const daemonHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore) => Promise<IpcResponse>
> = {
  ...sentraHandlers,

  async "daemon.ping"(req) {
    return ipcOk(req.id, "pong");
  },

  async "daemon.status"(req, store) {
    return ipcOk(
      req.id,
      daemonStatusSchema.required({ supportedBackends: true }).parse({
        pid: process.pid,
        supportedBackends,
        sessions: store.list().map((s) => ({
          id: s.id,
          name: s.name,
          configPath: s.configPath,
          projectDir: s.projectDir,
          serviceCount: Object.keys(s.config.project.services).length,
          subscriberCount: s.subscribers.size,
          createdAt: s.createdAt,
        })),
      }),
    );
  },

  async "daemon.shutdown"(req) {
    // Run the teardown as part of handling the request (destroy every session —
    // Stopping services and killing panes — and remove the socket/pid files),
    // Then ACK. `runShutdownHook()` resolves AFTER cleanup is done but schedules
    // The process exit for the next tick, so this `{ shuttingDown: true }`
    // Response still flushes to the caller first. This is deterministic across
    // Runtimes — the previous `setTimeout(…, 100)` defer was silently dropped by
    // The bun native binary when the event loop drained before it fired, leaving
    // Sockets/pids/panes/ports all leaked (D1).
    await runShutdownHook();
    return ipcOk(req.id, { shuttingDown: true });
  },

  async "session.list"(req, store) {
    return ipcOk(
      req.id,
      store.list().map((s) => {
        const host = s.compatibilityProjection();
        const entry = {
          id: s.id,
          name: s.name,
          configPath: s.configPath,
          projectDir: s.projectDir,
          createdAt: s.createdAt,
          backend: s.backend.id,
          capabilities: { ...s.backend.capabilities },
        };
        if (host.backend === "tmux") {
          return sessionListEntrySchema.parse(
            Object.assign(entry, {
              tmuxSession: host.tmuxSession,
              managed: host.managed,
              tuiPane: host.paneMap["@tui"] ?? null,
            }),
          );
        }
        return sessionListEntrySchema.parse(entry);
      }),
    );
  },

  async "session.create"(req, store) {
    const raw = z.record(z.string(), z.unknown()).safeParse(req.params);
    if (!raw.success) {
      return ipcErr(req.id, "invalid_request", "invalid_request");
    }
    if (!raw.data.configPath) {
      return ipcErr(req.id, "configPath required", "invalid_request");
    }
    if (
      Object.hasOwn(raw.data, "backend") &&
      !backendIdSchema.safeParse(raw.data.backend).success
    ) {
      return ipcErr(req.id, "invalid_backend", "invalid_backend");
    }
    if (raw.data.backend !== "shell") {
      const socket = raw.data.tmuxSocket;
      if (socket !== undefined && socket !== null && !isSocketName(socket)) {
        return ipcErr(req.id, "tmuxSocket must be a non-empty string or null", "invalid_request");
      }
      if (raw.data.managedTmux === true && (socket === undefined || socket === null)) {
        return ipcErr(req.id, "managed session requires tmuxSocket", "invalid_request");
      }
    }
    const params = (() => {
      try {
        return normalizeLegacySessionCreateParams(raw.data);
      } catch {
        return null;
      }
    })();
    if (!params) {
      return ipcErr(req.id, "invalid_request", "invalid_request");
    }
    const context = (() => {
      try {
        return req.context !== undefined
          ? parseRequestContext(req.context)
          : { cwd: params.projectDir, env: captureEnvironment() };
      } catch {
        return null;
      }
    })();
    if (!context) {
      return ipcErr(req.id, "invalid request context", "invalid_request");
    }

    try {
      const session = await store.create({
        ...params,
        projectDir: params.projectDir || context.cwd,
        shellEnv: context.env,
      });
      const host = session.compatibilityProjection();
      return ipcOk(
        req.id,
        sessionCreatedSchema.parse({
          backend: session.backend.id,
          capabilities: { ...session.backend.capabilities },
          id: session.id,
          name: session.name,
          paneMap: host.paneMap,
          ...(host.focusPane === undefined ? {} : { focusPane: host.focusPane }),
        }),
      );
    } catch (error) {
      // `buildSession` loads config first (server.ts) — a throw here leaves no
      // Partial session registered. Log the full error before the IPC message.
      logConfigError(error);
      return ipcErr(req.id, error);
    }
  },

  async "session.destroy"(req, store) {
    const sessionId = req.session;
    if (!sessionId) {
      return ipcErr(req.id, "session required");
    }
    const session = store.get(sessionId);
    if (!session) {
      return ipcErr(req.id, `Unknown session: ${sessionId}`);
    }
    if (req.context) {
      session.updateContext(parseRequestContext(req.context).env);
    }
    await (req.context
      ? session.runWithContext(async () => store.destroy(sessionId))
      : store.destroy(sessionId));
    return ipcOk(req.id, { destroyed: sessionId });
  },
};
