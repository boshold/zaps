import type { SessionStore } from "#src/daemon/server.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";

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

  async "daemon.shutdown"(req, store) {
    // Ack the caller first so `{ shuttingDown: true }` is written back before the
    // Socket goes away, then defer the full teardown (destroy every session,
    // Remove socket/pid, exit) so the ndjson response flushes before the server
    // Closes (D1). The defer delegates to the shared `shutdownAll()` path.
    setTimeout(() => {
      store.requestShutdown?.();
    }, 100);
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
      })),
    );
  },

  async "session.create"(req, store) {
    const params = req.params as {
      configPath: string;
      projectDir: string;
      tmuxSession: string;
      originPane: string;
    };

    if (!params?.configPath) {
      return ipcErr(req.id, "configPath required");
    }

    try {
      const session = await store.create(params);
      return ipcOk(req.id, {
        id: session.id,
        name: session.name,
        paneMap: session.paneMap,
      });
    } catch (error) {
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
