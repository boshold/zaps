import type { Socket } from "node:net";

import { z } from "zod";

import type { ResolvedConfig } from "#src/config/types.js";
import type { TaskExecutionService } from "#src/daemon/task-execution.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import type { ServiceManager } from "#src/lib/service/manager.js";

type Handler = (
  req: IpcRequest,
  manager: ServiceManager,
  config: ResolvedConfig,
  socket: Socket,
  taskExecution?: TaskExecutionService,
) => Promise<IpcResponse>;

function send(socket: Socket, msg: object): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

const handlers: Record<string, Handler> = {
  async ping(req) {
    return ipcOk(req.id, "pong");
  },

  async "services.list"(req, manager) {
    return ipcOk(req.id, manager.getAllStatuses());
  },

  async "services.details"(req, manager, config) {
    const { name } = req.params as { name: string };
    try {
      const status = manager.getStatus(name);
      const svcConfig = config.project.services[name];
      return ipcOk(req.id, {
        ...status,
        dependsOn: svcConfig?.dependsOn ?? [],
        hasDocker: Boolean(svcConfig?.docker),
      });
    } catch {
      return ipcErr(req.id, `Unknown service: ${name}`);
    }
  },

  async "services.start"(req, manager) {
    const { name } = req.params as { name: string };
    try {
      const result = await manager.startService(name);
      return ipcOk(req.id, { started: name, noop: result.noop });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.stop"(req, manager) {
    const { name } = req.params as { name: string };
    try {
      const result = await manager.stopService(name);
      return ipcOk(req.id, { stopped: name, noop: result.noop });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.restart"(req, manager) {
    const { name } = req.params as { name: string };
    try {
      await manager.restartService(name);
      return ipcOk(req.id, { restarted: name });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "tasks.list"(req, _manager, config) {
    const tasks = config.project.tasks ?? {};
    const list = Object.entries(tasks).map(([key, t]) => ({
      key,
      name: t.name,
      description: t.description ?? null,
    }));
    return ipcOk(req.id, list);
  },

  async "tasks.run"(req, _manager, config, socket, taskExecution) {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    if (!config.project.tasks?.[key]) {
      return ipcErr(req.id, `Unknown task: ${key}`);
    }
    if (!taskExecution) {
      return ipcErr(req.id, "Task execution requires a session");
    }
    const outcome = await taskExecution.run(key, {
      config,
      cwd: config.projectDir,
      env: {},
      mode: "background",
      onLine: (line) => {
        if (!socket.destroyed && socket.writable) {
          send(socket, { id: req.id, event: "line", data: line });
        }
      },
      onProgress: (taskKey, result) => {
        if (!socket.destroyed && socket.writable) {
          send(socket, { id: req.id, event: "progress", data: { key: taskKey, result } });
        }
      },
    });
    return ipcOk(req.id, outcome);
  },
};

export async function handleRequest(
  req: IpcRequest,
  manager: ServiceManager,
  config: ResolvedConfig,
  socket: Socket,
  taskExecution?: TaskExecutionService,
): Promise<IpcResponse> {
  const handler = handlers[req.method];
  if (!handler) {
    return ipcErr(req.id, `Unknown method: ${req.method}`);
  }
  try {
    return await handler(req, manager, config, socket, taskExecution);
  } catch (error) {
    return ipcErr(req.id, error instanceof Error ? error.message : String(error));
  }
}
