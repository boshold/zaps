import type { Socket } from "node:net";

import type { Command, DockerConfig, ResolvedConfig } from "#src/config/types.js";
import type { SessionStore } from "#src/daemon/server.js";
import type { Session } from "#src/daemon/session.js";
import { execCommand } from "#src/lib/exec.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { newRunId } from "#src/lib/task/run-id.js";
import { awaitPaneOutcome, buildPaneCommand } from "#src/lib/task/run-in-pane.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";
import { newWindow, sendKeys, splitPane } from "#src/lib/tmux.js";

function send(socket: Socket, msg: object): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

function getSession(req: IpcRequest, store: SessionStore): Session | null {
  if (!req.session) {
    return null;
  }
  return store.get(req.session) ?? null;
}

/** Normalize a task's optional `commands` field to a flat list. */
function normalizeCommands(commands: Command | Command[] | undefined): Command[] {
  if (!commands) {
    return [];
  }
  return Array.isArray(commands) ? commands : [commands];
}

/** Record + broadcast the terminal state of a run-in-pane run. */
function completePaneRun(
  session: Session,
  runId: string,
  taskKey: string,
  taskName: string,
  result: "success" | "error",
): void {
  session.pushTaskRecord({ runId, taskKey, taskName, result, timestamp: Date.now(), mode: "pane" });
  session.broadcast({
    session: session.id,
    event: "task.complete",
    data: { key: taskKey, name: taskName, result, runId },
  });
}

/**
 * Watch a launched pane run to completion and broadcast `task.complete`. Run
 * fire-and-forget: `tasks.runInPane` returns once the pane exists, while the run
 * itself streams live in the pane and finishes asynchronously.
 */
async function watchPaneOutcome(
  session: Session,
  runId: string,
  taskKey: string,
  taskName: string,
): Promise<void> {
  let result: "success" | "error" = "error";
  try {
    result = await awaitPaneOutcome(runId);
  } catch {
    result = "error";
  }
  completePaneRun(session, runId, taskKey, taskName, result);
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
  const serviceCtx = buildServiceContext(statuses, config.projectDir, config.project.services);

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

export const sessionHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore, socket: Socket) => Promise<IpcResponse>
> = {
  async "session.attach"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    return ipcOk(req.id, session.attachSnapshot());
  },

  async "session.detach"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    session.removeSubscriber(socket);
    return ipcOk(req.id, { detached: true });
  },

  async subscribe(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    // Subscriber removal on close/error is handled once at the server level
    // (server.ts cleanupSubscriptions) — registering a per-subscribe `close`
    // Listener here stacked one per subscribe call and tripped the EventEmitter
    // Max-listeners warning (D7).
    session.addSubscriber(socket);

    return ipcOk(req.id, { subscribed: true });
  },

  async "session.reload"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    try {
      await session.reload();
      return ipcOk(req.id, { reloaded: true });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    return ipcOk(req.id, session.manager.getAllStatuses());
  },

  async "services.details"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      const status = session.manager.getStatus(name);
      const svcConfig = session.config.project.services[name];
      return ipcOk(req.id, {
        ...status,
        dependsOn: svcConfig?.dependsOn ?? [],
        hasDocker: Boolean(svcConfig?.docker),
      });
    } catch {
      return ipcErr(req.id, `Unknown service: ${name}`);
    }
  },

  async "services.start"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      const result = await session.manager.startService(name);
      return ipcOk(req.id, { started: name, noop: result.noop });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.stop"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      const result = await session.manager.stopService(name);
      return ipcOk(req.id, { stopped: name, noop: result.noop });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.restart"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      await session.manager.restartService(name);
      return ipcOk(req.id, { restarted: name });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.rebuild"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name, overrides } = req.params as { name: string; overrides: Partial<DockerConfig> };
    try {
      await session.manager.restartWithDockerOverrides(name, overrides);
      return ipcOk(req.id, { rebuilt: name });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.startAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential start respects deps
        for (const name of params.names) {
          await session.manager.startService(name);
        }
        return ipcOk(req.id, { started: params.names });
      }
      await session.manager.startAll();
      return ipcOk(req.id, { started: "all" });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.stopAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential stop for safety
        for (const name of params.names) {
          await session.manager.stopService(name);
        }
        return ipcOk(req.id, { stopped: params.names });
      }
      await session.manager.stopAll();
      return ipcOk(req.id, { stopped: "all" });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "services.restartAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const params = req.params as { names?: string[] } | undefined;
    try {
      if (params?.names) {
        // eslint-disable-next-line no-await-in-loop -- Sequential restart for safety
        for (const name of params.names) {
          await session.manager.restartService(name);
        }
        return ipcOk(req.id, { restarted: params.names });
      }
      // Restart all: stop all then start all
      await session.manager.stopAll();
      await session.manager.startAll();
      return ipcOk(req.id, { restarted: "all" });
    } catch (error) {
      return ipcErr(req.id, error instanceof Error ? error.message : String(error));
    }
  },

  async "tasks.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const tasks = session.config.project.tasks ?? {};
    const list = Object.entries(tasks).map(([key, t]) => ({
      key,
      name: t.name,
      description: t.description ?? null,
    }));
    return ipcOk(req.id, list);
  },

  async "tasks.run"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }

    const { key } = req.params as { key: string };
    const tasks = session.config.project.tasks ?? {};
    if (!tasks[key]) {
      return ipcErr(req.id, `Unknown task: ${key}`);
    }

    const task = tasks[key];
    const taskName = task.name;
    const isPopup = Boolean(task.popup) && task.commands && !task.run;

    // One runId per run correlates this run's start/complete + (Phase 5) output,
    // So concurrent runs of the same key stay independent (Q12).
    const runId = newRunId();

    // Record + broadcast task.start to all subscribers
    session.pushTaskRecord({
      runId,
      taskKey: key,
      taskName,
      result: "running",
      timestamp: Date.now(),
      mode: "background",
    });
    session.broadcast({
      session: session.id,
      event: "task.start",
      data: { key, name: taskName, runId },
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
          services: session.config.project.services,
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

    // Record + broadcast task.complete to all subscribers
    session.pushTaskRecord({
      runId,
      taskKey: key,
      taskName,
      result: success ? "success" : "error",
      timestamp: Date.now(),
    });
    session.broadcast({
      session: session.id,
      event: "task.complete",
      data: { key, name: taskName, result: success ? "success" : "error", runId },
    });

    return ipcOk(req.id, { success, runId });
  },

  async "tasks.runInPane"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }

    const { key, target = "window" } = req.params as {
      key: string;
      target?: "pane" | "window";
    };
    const tasks = session.config.project.tasks ?? {};
    const task = tasks[key];
    if (!task) {
      return ipcErr(req.id, "unknown_task");
    }

    // Resolve the task's shell commands (functions get the live service context).
    const statuses = new Map(
      session.manager.getAllStatuses().map((s) => [s.name, s] as [string, ServiceStatus]),
    );
    const serviceCtx = buildServiceContext(
      statuses,
      session.config.projectDir,
      session.config.project.services,
    );
    const rawCommands = normalizeCommands(task.commands);
    const resolvedCommands = rawCommands.map((cmd) =>
      typeof cmd === "function" ? cmd(serviceCtx) : cmd,
    );
    if (resolvedCommands.length === 0) {
      return ipcErr(req.id, `Task ${key} has no shell commands to run in a pane`);
    }

    const taskName = task.name;
    // One runId per run correlates start/complete + the stored pane (Q12/T01).
    const runId = newRunId();

    // Create the pane/window; both helpers return the new pane id (the spec's
    // Default target is a new window — a split would reflow the service panes).
    let paneId = "";
    try {
      paneId =
        target === "pane"
          ? await splitPane(session.paneMap["@tui"] ?? session.originPane, "v")
          : await newWindow(session.tmuxSession);
    } catch {
      return ipcErr(req.id, "tmux_failed");
    }
    session.panesByRun.set(runId, paneId);

    // Record + broadcast task.start with mode:"pane" so the run is correlatable.
    session.pushTaskRecord({
      runId,
      taskKey: key,
      taskName,
      result: "running",
      timestamp: Date.now(),
      mode: "pane",
    });
    session.broadcast({
      session: session.id,
      event: "task.start",
      data: { key, name: taskName, runId },
    });

    const cwd = task.cwd ?? session.config.projectDir;
    const env = resolveEnv(task.env, serviceCtx);
    const command = buildPaneCommand(resolvedCommands, { cwd, env, runId });
    try {
      await sendKeys(paneId, command);
    } catch {
      completePaneRun(session, runId, key, taskName, "error");
      return ipcErr(req.id, "tmux_failed");
    }

    // The run renders live in the pane; completion is detected daemon-side via
    // The run's wait-for channel (not pane scraping), then broadcast. The pane is
    // Left open on completion so the user can inspect output in place (Q13).
    void watchPaneOutcome(session, runId, key, taskName);

    return ipcOk(req.id, { runId, paneId });
  },

  async "exec-service.resolve"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { service } = req.params as { service: string };
    const info = session.execInfo.get(service);
    if (!info) {
      return ipcErr(req.id, `No exec info for service: ${service}`);
    }
    session.execInfo.delete(service);
    return ipcOk(req.id, info);
  },

  async "exec-service.exited"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { service, code, signal, spawnError } = req.params as {
      service: string;
      code: number;
      signal?: string | null;
      spawnError?: string;
    };
    session.manager.handleExecExited(service, code, signal ?? null, spawnError);
    return ipcOk(req.id, { ok: true });
  },

  async "logs.snapshot"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { service } = req.params as { service: string };
    const buf = session.logBuffers.get(service);
    if (!buf) {
      return ipcErr(req.id, `Unknown service: ${service}`);
    }
    return ipcOk(req.id, buf.snapshot());
  },
};
