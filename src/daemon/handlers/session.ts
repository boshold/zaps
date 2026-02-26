import type { ResolvedConfig } from "#src/config/types.js";
import type { SessionStore } from "#src/daemon/server.js";
import type { Session } from "#src/daemon/session.js";
import { execCommand } from "#src/lib/exec.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";
import type { Socket } from "node:net";

function ok(id: string, result: unknown): IpcResponse {
  return { id, result };
}

function err(id: string, error: string): IpcResponse {
  return { id, error };
}

function send(socket: Socket, msg: object): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

function getSession(req: IpcRequest, store: SessionStore): Session | null {
  if (!req.session) {
    return null;
  }
  return store.get(req.session) ?? null;
}

async function runPopupTaskNonInteractive(
  reqId: string,
  key: string,
  config: ResolvedConfig,
  manager: ServiceManager,
  socket: Socket,
): Promise<boolean> {
  const tasks = config.project.tasks ?? {};
  const task = tasks[key];
  if (!task?.commands) {
    return false;
  }

  const commands = Array.isArray(task.commands) ? task.commands : [task.commands];
  const resolved = commands.map((cmd) => (typeof cmd === "function" ? cmd() : cmd));

  const statuses = new Map(manager.getAllStatuses().map((s) => [s.name, s]));
  const serviceCtx = buildServiceContext(statuses, config.projectDir);
  const resolvedEnv = resolveEnv(task.env, serviceCtx);
  const taskCwd = task.cwd ?? config.projectDir;

  try {
    for (const cmd of resolved) {
      await execCommand(cmd, {
        cwd: taskCwd,
        ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
        onLine: (line) => {
          send(socket, { id: reqId, event: "line", data: line });
        },
      });
    }
    return true;
  } catch {
    return false;
  }
}

export const sessionHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore, socket: Socket) => Promise<IpcResponse>
> = {
  async "session.attach"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    return ok(req.id, session.attachSnapshot());
  },

  async "session.detach"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    session.subscribers.delete(socket);
    return ok(req.id, { detached: true });
  },

  async subscribe(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    session.subscribers.add(socket);

    socket.on("close", () => {
      session.subscribers.delete(socket);
    });

    return ok(req.id, { subscribed: true });
  },

  async "services.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    return ok(req.id, session.manager.getAllStatuses());
  },

  async "services.details"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      const status = session.manager.getStatus(name);
      const svcConfig = session.config.project.services[name];
      return ok(req.id, {
        ...status,
        dependsOn: svcConfig?.dependsOn ?? [],
        hasDocker: Boolean(svcConfig?.docker),
      });
    } catch {
      return err(req.id, `Unknown service: ${name}`);
    }
  },

  async "services.start"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      await session.manager.startService(name);
      return ok(req.id, { started: name });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.stop"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      await session.manager.stopService(name);
      return ok(req.id, { stopped: name });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.restart"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      await session.manager.restartService(name);
      return ok(req.id, { restarted: name });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.startAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential start respects deps
        for (const name of params.names) {
          await session.manager.startService(name);
        }
        return ok(req.id, { started: params.names });
      }
      await session.manager.startAll();
      return ok(req.id, { started: "all" });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.stopAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential stop for safety
        for (const name of params.names) {
          await session.manager.stopService(name);
        }
        return ok(req.id, { stopped: params.names });
      }
      await session.manager.stopAll();
      return ok(req.id, { stopped: "all" });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.restartAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential restart for safety
        for (const name of params.names) {
          await session.manager.restartService(name);
        }
        return ok(req.id, { restarted: params.names });
      }
      // Restart all: stop all then start all
      await session.manager.stopAll();
      await session.manager.startAll();
      return ok(req.id, { restarted: "all" });
    } catch (error) {
      return err(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "tasks.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const tasks = session.config.project.tasks ?? {};
    const list = Object.entries(tasks).map(([key, t]) => ({
      key,
      name: t.name,
      description: t.description ?? null,
    }));
    return ok(req.id, list);
  },

  async "tasks.run"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }

    const { key } = req.params as { key: string };
    const tasks = session.config.project.tasks ?? {};
    if (!tasks[key]) {
      return err(req.id, `Unknown task: ${key}`);
    }

    const task = tasks[key];
    const taskName = task.name;
    const isPopup = Boolean(task.popup) && task.commands && !task.run;

    // Broadcast task.start to all subscribers
    session.broadcast({
      session: session.id,
      event: "task.start",
      data: { key, name: taskName },
    });

    let success = false;
    if (isPopup) {
      success = await runPopupTaskNonInteractive(
        req.id,
        key,
        session.config,
        session.manager,
        socket,
      );
    } else {
      const visited = new Set<string>();
      const results = new Map<string, "success" | "error">();
      success = await runTaskWithDeps(
        key,
        {
          tasks,
          statuses: new Map(
            session.manager.getAllStatuses().map((s) => [s.name, s] as [string, ServiceStatus]),
          ),
          projectDir: session.config.projectDir,
          onLine: (_taskKey, line) => {
            send(socket, { id: req.id, event: "line", data: line });
          },
          onProgress: (taskKey, result) => {
            send(socket, { id: req.id, event: "progress", data: { key: taskKey, result } });
          },
        },
        visited,
        results,
      );
    }

    // Broadcast task.complete to all subscribers
    session.broadcast({
      session: session.id,
      event: "task.complete",
      data: { key, name: taskName, result: success ? "success" : "error" },
    });

    return ok(req.id, { success });
  },

  async "logs.snapshot"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return err(req.id, "Unknown session");
    }
    const { service } = req.params as { service: string };
    const buf = session.logBuffers.get(service);
    if (!buf) {
      return err(req.id, `Unknown service: ${service}`);
    }
    return ok(req.id, buf.snapshot());
  },
};
