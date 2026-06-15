import type { Socket } from "node:net";

import type { ResolvedConfig } from "#src/config/types.js";
import { execCommand } from "#src/lib/exec.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

type Handler = (
  req: IpcRequest,
  manager: ServiceManager,
  config: ResolvedConfig,
  socket: Socket,
) => Promise<IpcResponse>;

function send(socket: Socket, msg: object): void {
  socket.write(`${JSON.stringify(msg)}\n`);
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

  const statuses = new Map(manager.getAllStatuses().map((s) => [s.name, s]));
  const serviceCtx = buildServiceContext(statuses, config.projectDir);

  const commands = Array.isArray(task.commands) ? task.commands : [task.commands];
  const resolved = commands.map((cmd) => (typeof cmd === "function" ? cmd(serviceCtx) : cmd));
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

  async "tasks.run"(req, manager, config, socket) {
    const { key } = req.params as { key: string };
    const tasks = config.project.tasks ?? {};
    if (!tasks[key]) {
      return ipcErr(req.id, `Unknown task: ${key}`);
    }

    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    // For popup tasks with commands, run non-interactively (skip popup)
    const task = tasks[key];
    const isPopup = Boolean(task.popup) && task.commands && !task.run;

    const success = isPopup
      ? await runPopupTaskNonInteractive(req.id, key, config, manager, socket)
      : await runTaskWithDeps(
          key,
          {
            tasks,
            statuses: new Map(
              manager.getAllStatuses().map((s) => [s.name, s] as [string, ServiceStatus]),
            ),
            projectDir: config.projectDir,
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

    return ipcOk(req.id, { success });
  },
};

export async function handleRequest(
  req: IpcRequest,
  manager: ServiceManager,
  config: ResolvedConfig,
  socket: Socket,
): Promise<IpcResponse> {
  const handler = handlers[req.method];
  if (!handler) {
    return ipcErr(req.id, `Unknown method: ${req.method}`);
  }
  try {
    return await handler(req, manager, config, socket);
  } catch (error) {
    return ipcErr(req.id, error instanceof Error ? error.message : String(error));
  }
}
