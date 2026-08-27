import { logConfigError } from "#src/daemon/log-config-error.js";
import type { SessionStore } from "#src/daemon/server.js";
import { runShutdownHook } from "#src/daemon/shutdown.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";

/** A tmux socket name is a non-empty, non-blank string (used verbatim for `-L`). */
function isSocketName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export const daemonHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore) => Promise<IpcResponse>
> = {
  async "daemon.ping"(req) {
    return ipcOk(req.id, "pong");
  },

  async "daemon.status"(req, store) {
    return ipcOk(req.id, {
      pid: process.pid,
      sessions: store.list().map((s) => ({
        id: s.id,
        name: s.name,
        configPath: s.configPath,
        projectDir: s.projectDir,
        serviceCount: Object.keys(s.config.project.services).length,
        subscriberCount: s.subscribers.size,
        createdAt: s.createdAt,
      })),
    });
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
      store.list().map((s) => ({
        id: s.id,
        name: s.name,
        configPath: s.configPath,
        projectDir: s.projectDir,
        createdAt: s.createdAt,
        tmuxSession: s.tmuxSession,
        managed: s.managedTmux,
        // Lets an unattached client (the re-attach bootstrap) find the TUI pane
        // Without subscribing to the session.
        tuiPane: s.paneMap["@tui"] ?? null,
      })),
    );
  },

  async "session.create"(req, store) {
    const params = req.params as {
      configPath: string;
      projectDir: string;
      tmuxSession: string;
      originPane: string;
      tmuxSocket?: string | null;
      managedTmux?: boolean;
    };

    if (!params?.configPath) {
      return ipcErr(req.id, "configPath required");
    }

    // A socket is either absent/null (default server) or a non-empty name — an
    // Empty string must never silently degrade into "default server".
    const rawSocket = params.tmuxSocket;
    if (rawSocket !== undefined && rawSocket !== null && !isSocketName(rawSocket)) {
      return ipcErr(req.id, "tmuxSocket must be a non-empty string or null");
    }
    const tmuxSocket = typeof rawSocket === "string" ? rawSocket : null;
    const managedTmux = params.managedTmux === true;
    // The daemon must never kill-session on the user's default server (50_api).
    if (managedTmux && tmuxSocket === null) {
      return ipcErr(req.id, "managed session requires tmuxSocket");
    }

    try {
      const session = await store.create({ ...params, tmuxSocket, managedTmux });
      return ipcOk(req.id, {
        id: session.id,
        name: session.name,
        paneMap: session.paneMap,
        focusPane: session.focusPane,
      });
    } catch (error) {
      // `buildSession` loads config first (server.ts) — a throw here leaves no
      // Partial session registered. Log the full error before the IPC message.
      logConfigError(error);
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
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
    await store.destroy(sessionId);
    return ipcOk(req.id, { destroyed: sessionId });
  },
};
