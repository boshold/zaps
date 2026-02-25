import type { SessionStore } from "#src/daemon/server.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";

function ok(id: string, result: unknown): IpcResponse {
  return { id, result };
}

function err(id: string, error: string): IpcResponse {
  return { id, error };
}

export const daemonHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore) => Promise<IpcResponse>
> = {
  async "daemon.ping"(req) {
    return ok(req.id, "pong");
  },

  async "daemon.status"(req, store) {
    return ok(req.id, {
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
    // Graceful shutdown — let the caller handle process.exit
    setTimeout(() => {
      process.exit(0);
    }, 100);
    return ok(req.id, { shutting_down: true });
  },

  async "session.list"(req, store) {
    return ok(
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
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- IPC protocol
    const params = req.params as {
      configPath: string;
      projectDir: string;
      tmuxSession: string;
      originPane: string;
    };

    if (!params?.configPath) {
      return err(req.id, "configPath required");
    }

    try {
      const session = await store.create(params);
      return ok(req.id, {
        id: session.id,
        name: session.name,
        paneMap: session.paneMap,
      });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "session.destroy"(req, store) {
    const sessionId = req.session;
    if (!sessionId) {
      return err(req.id, "session required");
    }
    const session = store.get(sessionId);
    if (!session) {
      return err(req.id, `Unknown session: ${sessionId}`);
    }
    await store.destroy(sessionId);
    return ok(req.id, { destroyed: sessionId });
  },
};
