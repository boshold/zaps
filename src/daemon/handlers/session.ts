import type { Socket } from "node:net";

import { z } from "zod";

import type { Command, DockerConfig } from "#src/config/types.js";
import { logConfigError } from "#src/daemon/log-config-error.js";
import type { SessionStore } from "#src/daemon/server.js";
import type { Session } from "#src/daemon/session.js";
import { SessionClosingError } from "#src/lib/backend/admission-error.js";
import type { TerminalActionParams } from "#src/lib/backend/schemas.js";
import { terminalActionParamsSchema } from "#src/lib/backend/schemas.js";
import { TerminalOperationError } from "#src/lib/backend/terminal-error.js";
import {
  serviceWrappers,
  wrapperExitSchema,
  wrapperIdentitySchema,
} from "#src/lib/backend/tmux/runtime.js";
import { wrapperStartedSchema } from "#src/lib/backend/tmux/wrapper-schema.js";
import { projectedStatusSchema, sessionSnapshotSchema } from "#src/lib/backend/wire.js";
import { ipcErr, ipcOk, startAllParamsSchema } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { parseRequestContext } from "#src/lib/request-context.js";
import { sanitizeSegment, sentraEnvFor } from "#src/lib/sentra/config.js";
import { buildServiceContext, resolveEnv } from "#src/lib/service/env.js";
import { GroupedDockerRebuildError } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { planTaskServices, summarizePlan } from "#src/lib/task/ensure-services.js";
import type { TaskPreflight, TaskServiceEvent } from "#src/lib/task/ensure-services.js";
import { buildTaskListEntries } from "#src/lib/task/list-entry.js";
import { newRunId } from "#src/lib/task/run-id.js";
import { buildWrapperCommand, joinTaskCommands } from "#src/lib/task/run-in-pane.js";
import { resolveTaskServiceRequirements } from "#src/lib/task/service-requirements.js";

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

/** Run `Session.prepareTask`, aborting it when the request socket closes. */
async function prepareForRequest(
  session: Session,
  socket: Socket,
  key: string,
  start: boolean | undefined,
  onEvent?: (event: TaskServiceEvent) => void,
): Promise<string[]> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  socket.once("close", onClose);
  if (socket.destroyed) {
    controller.abort();
  }
  try {
    const { startedServices } = await session.prepareTask(key, {
      start,
      signal: controller.signal,
      onEvent,
    });
    return startedServices;
  } finally {
    socket.off("close", onClose);
  }
}

async function runTask(req: IpcRequest, session: Session, socket: Socket): Promise<IpcResponse> {
  const { key, start } = z
    .object({ key: z.string(), start: z.boolean().optional() })
    .parse(req.params);
  const tasks = session.config.project.tasks ?? {};
  if (!Object.hasOwn(tasks, key)) {
    return ipcErr(req.id, `Unknown task: ${key}`);
  }

  let startedServices: string[] = [];
  try {
    startedServices = await prepareForRequest(session, socket, key, start, (event) => {
      if (!socket.destroyed && socket.writable) {
        send(socket, { id: req.id, event: "service", data: event });
      }
    });
  } catch (error) {
    return ipcErr(req.id, error);
  }

  const outcome = await session.taskExecution.run(key, {
    startedServices,
    config: session.config,
    cwd: session.config.projectDir,
    env: session.env,
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
  return ipcOk(req.id, { ...outcome, startedServices });
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

/** Copy, so the manager's live status never carries a stale count. */
function withErrorCount(
  status: ServiceStatus,
  errorCount: number | null,
): ServiceStatus & { sentra: boolean; errorCount: number | null } {
  return { ...status, sentra: status.sentra ?? false, errorCount };
}

function popupCapabilityError(
  session: Session,
  params: Extract<TerminalActionParams, { action: "taskPicker" | "taskOutput" }>,
): "unsupported_capability" | "invalid_request" | undefined {
  if (!session.backend.capabilities.popups) {
    return "unsupported_capability";
  }
  return params.action === "taskOutput" && !session.taskOutput.get(params.runId)
    ? "invalid_request"
    : undefined;
}

function terminalCapabilityError(
  session: Session,
  params: TerminalActionParams,
): "unsupported_capability" | "invalid_request" | undefined {
  const { terminal, capabilities } = session.backend;
  if (!terminal) {
    return "unsupported_capability";
  }
  if (params.action === "taskPicker" || params.action === "taskOutput") {
    return popupCapabilityError(session, params);
  }
  if (
    !capabilities.panes ||
    (params.action === "zoom" && !capabilities.zoom) ||
    (params.action === "editOutput" && !capabilities.popups)
  ) {
    return "unsupported_capability";
  }
  const view = session.backend.getPresentation();
  if (view.kind !== "tmux") {
    return "unsupported_capability";
  }
  let service: string | undefined = undefined;
  if (params.action === "editOutput") {
    ({ service } = params);
  }
  if ((params.action === "focus" || params.action === "zoom") && params.target.kind === "service") {
    service = params.target.name;
  }
  if (service !== undefined) {
    if (!Object.hasOwn(session.config.project.services, service)) {
      return "invalid_request";
    }
    if (session.config.project.services[service]?.detached || !view.paneMap[service]) {
      return "unsupported_capability";
    }
  }
  return undefined;
}

function activeUiBinding(session: Session, socket: Socket) {
  const binding = session.getUiBinding(socket);
  if (
    !binding ||
    !binding.acknowledged ||
    binding.sessionId !== session.id ||
    binding.socket !== socket ||
    socket.destroyed ||
    !socket.writable ||
    binding.controller.signal.aborted
  ) {
    return undefined;
  }
  return binding;
}

function terminalContext(req: IpcRequest, session: Session) {
  try {
    return req.context === undefined
      ? { cwd: session.config.projectDir, env: { ...session.env } }
      : parseRequestContext(req.context);
  } catch {
    return null;
  }
}

export const sessionHandlers: Record<
  string,
  (req: IpcRequest, store: SessionStore, socket: Socket) => Promise<IpcResponse>
> = {
  async "terminal.action"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const fail = (
      code:
        | "invalid_request"
        | "unsupported_capability"
        | "session_closing"
        | "backend_unavailable"
        | "terminal_busy",
    ) => ({ ...ipcErr(req.id, code), errorCode: code });
    if (!session.taskExecution.accepting) {
      return fail("session_closing");
    }
    const binding = activeUiBinding(session, socket);
    const parsed = terminalActionParamsSchema.safeParse(req.params);
    if (!binding || !parsed.success) {
      return fail("invalid_request");
    }
    const params = parsed.data;
    const capabilityError = terminalCapabilityError(session, params);
    if (capabilityError) {
      return fail(capabilityError);
    }
    const { terminal } = session.backend;
    if (!terminal) {
      return fail("unsupported_capability");
    }
    const context = terminalContext(req, session);
    if (!context) {
      return fail("invalid_request");
    }
    try {
      const operation = {
        id: binding.socketId,
        cwd: context.cwd,
        env: context.env,
        signal: binding.controller.signal,
      };
      switch (params.action) {
        case "focus":
        case "zoom": {
          await terminal[params.action](params.target);
          break;
        }
        case "editOutput": {
          await terminal.editOutput(params.service, operation);
          break;
        }
        case "taskOutput": {
          await terminal.taskOutput(params.runId, operation);
          break;
        }
        case "taskPicker": {
          const taskKey = await terminal.taskPicker(operation);
          if (taskKey !== null && !Object.hasOwn(session.config.project.tasks ?? {}, taskKey)) {
            return fail("invalid_request");
          }
          return ipcOk(req.id, { action: params.action, taskKey });
        }
        default: {
          return fail("invalid_request");
        }
      }
      return ipcOk(req.id, { action: params.action, done: true });
    } catch (error) {
      if (error instanceof TerminalOperationError) {
        return fail(error.code === "cancelled" ? "invalid_request" : error.code);
      }
      return fail("backend_unavailable");
    }
  },

  async "session.attach"(req, store, socket) {
    const params = z
      .object({ ui: z.boolean().optional() })
      .strict()
      .optional()
      .safeParse(req.params);
    if (!params.success) {
      return ipcErr(req.id, "invalid_request", "invalid_request");
    }
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    if (params.data?.ui) {
      try {
        session.bindUi(socket);
      } catch (error) {
        return ipcErr(req.id, error);
      }
    }
    return ipcOk(req.id, sessionSnapshotSchema.parse(session.attachSnapshot()));
  },

  async "session.detach"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const fail = (code: "invalid_request" | "session_closing" | "backend_unavailable") => ({
      ...ipcErr(req.id, code),
      errorCode: code,
    });
    const params = z
      .object({ detachHost: z.boolean().optional() })
      .strict()
      .optional()
      .safeParse(req.params);
    if (!params.success) {
      return fail("invalid_request");
    }
    if (params.data?.detachHost) {
      if (!session.taskExecution.accepting) {
        return fail("session_closing");
      }
      const binding = activeUiBinding(session, socket);
      if (!binding) {
        return fail("invalid_request");
      }
      const view = session.backend.getPresentation();
      if (view.kind === "tmux" && view.managedTmux) {
        const { terminal } = session.backend;
        if (!terminal?.detachHost) {
          return fail("backend_unavailable");
        }
        try {
          await terminal.detachHost(
            {
              id: binding.socketId,
              cwd: session.config.projectDir,
              env: { ...session.env },
              signal: binding.controller.signal,
            },
            () => session.taskExecution.accepting && activeUiBinding(session, socket) === binding,
          );
        } catch {
          return fail("backend_unavailable");
        }
      }
      if (!session.taskExecution.accepting || activeUiBinding(session, socket) !== binding) {
        return fail("backend_unavailable");
      }
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
      // Log the full error (with ConfigError attribution) locally before sending
      // The message-only IPC response — the running session is left intact (A1).
      logConfigError(error);
      return ipcErr(req.id, error);
    }
  },

  async "services.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const statuses = session
      .projectStatuses()
      .map((status) =>
        withErrorCount(
          status,
          status.sentra
            ? (store.sentraCounter.get(session.id, sanitizeSegment(status.name)) ?? 0)
            : null,
        ),
      );
    return ipcOk(req.id, z.array(projectedStatusSchema).parse(statuses));
  },

  async "services.details"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name } = req.params as { name: string };
    try {
      const status = session.projectStatus(session.manager.getStatus(name));
      const svcConfig = session.config.project.services[name];
      return ipcOk(
        req.id,
        projectedStatusSchema
          .extend({ dependsOn: z.array(z.string()), hasDocker: z.boolean() })
          .parse({
            ...status,
            dependsOn: svcConfig?.dependsOn ?? [],
            hasDocker: Boolean(svcConfig?.docker),
          }),
      );
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
      return ipcErr(req.id, error);
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
      return ipcErr(req.id, error);
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
      return ipcErr(req.id, error);
    }
  },

  async "services.rebuild"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { name, overrides } = req.params as { name: string; overrides: Partial<DockerConfig> };
    if (session.config.project.services[name]?._combined) {
      const error = new GroupedDockerRebuildError(name);
      return { ...ipcErr(req.id, error.message), errorCode: error.code };
    }
    try {
      await session.manager.restartWithDockerOverrides(name, overrides);
      return ipcOk(req.id, { rebuilt: name });
    } catch (error) {
      if (error instanceof GroupedDockerRebuildError) {
        return { ...ipcErr(req.id, error.message), errorCode: error.code };
      }
      return ipcErr(req.id, error);
    }
  },

  async "services.startAll"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const params = startAllParamsSchema.safeParse(req.params);
    if (!params.success) {
      return ipcErr(req.id, "Invalid services.startAll parameters", "invalid_request");
    }
    try {
      const options = params.data;
      if (options && "names" in options) {
        // eslint-disable-next-line no-await-in-loop -- Sequential start respects deps
        for (const name of options.names) {
          await session.manager.startService(name);
        }
        return ipcOk(req.id, { started: options.names });
      }
      if (session.startupPending) {
        session.beginInitialStartup();
      }
      await (options && "startup" in options
        ? session.waitForInitialStartup()
        : session.manager.startAll());
      return ipcOk(req.id, { started: "all" });
    } catch (error) {
      return ipcErr(req.id, error);
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
      return ipcErr(req.id, error);
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
      return ipcErr(req.id, error);
    }
  },

  async "tasks.list"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    return ipcOk(req.id, buildTaskListEntries(session.config.project.tasks ?? {}));
  },

  async "tasks.preflight"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const parsed = z.strictObject({ key: z.string() }).safeParse(req.params);
    if (!parsed.success) {
      return ipcErr(req.id, "invalid_request", "invalid_request");
    }
    const { key } = parsed.data;
    const tasks = session.config.project.tasks ?? {};
    if (!Object.hasOwn(tasks, key)) {
      return ipcErr(req.id, `Unknown task: ${key}`);
    }
    const plan = planTaskServices(
      resolveTaskServiceRequirements(tasks, key),
      session.manager.getAllStatuses(),
      session.config.project.services,
      session.config.unavailableServices,
    );
    const preflight: TaskPreflight = { key, services: plan, ...summarizePlan(plan) };
    return ipcOk(req.id, preflight);
  },

  async "tasks.run"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const release = session.acquireTask();
    try {
      return await runTask(req, session, socket);
    } finally {
      release();
    }
  },

  async "tasks.runInPane"(req, store, socket) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }

    const parsed = z
      .strictObject({
        key: z.string().min(1),
        target: z.enum(["pane", "window"]).default("window"),
        start: z.boolean().optional(),
      })
      .safeParse(req.params);
    if (!parsed.success) {
      return { ...ipcErr(req.id, "invalid_request"), errorCode: "invalid_request" };
    }
    const { key, target, start } = parsed.data;
    if (!session.taskExecution.accepting) {
      return {
        ...ipcErr(req.id, "session_closing", "session_closing"),
        errorCode: "session_closing",
      };
    }
    const { terminal } = session.backend;
    if (!terminal || !session.backend.capabilities.taskPanes) {
      return { ...ipcErr(req.id, "unsupported_capability"), errorCode: "unsupported_capability" };
    }
    const tasks = session.config.project.tasks ?? {};
    if (!Object.hasOwn(tasks, key)) {
      return ipcErr(req.id, "unknown_task");
    }
    const task = tasks[key];

    let startedServices: string[] = [];
    try {
      startedServices = await prepareForRequest(session, socket, key, start);
    } catch (error) {
      return ipcErr(req.id, error);
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

    // Stash the resolve info the exec-task wrapper will fetch over IPC, plus the
    // Metadata needed to complete the run when the wrapper reports its exit.
    const cwd = task.cwd ?? session.config.projectDir;
    const sentraEnv = await sentraEnvFor(
      session.deps.sentra,
      session.config.project.sentra,
      task.sentra,
      key,
    );
    const env = { ...session.env, ...sentraEnv, ...resolveEnv(task.env, serviceCtx) };
    session.paneRunInfo.set(runId, {
      command: joinTaskCommands(resolvedCommands),
      cwd,
      env,
      taskKey: key,
      taskName,
    });

    // Begin retaining this run's output (the wrapper streams lines into it).
    session.taskOutput.start(runId, key, Date.now());

    // Record + broadcast task.start with mode:"pane" so the run is correlatable.
    session.pushTaskRecord({
      runId,
      taskKey: key,
      taskName,
      result: "running",
      timestamp: Date.now(),
      mode: "pane",
      ...(startedServices.length > 0 ? { startedServices } : {}),
    });
    session.broadcast({
      session: session.id,
      event: "task.start",
      data: { key, name: taskName, runId },
    });

    // Launch the wrapper in the pane: it resolves the command from the daemon,
    // Runs it, tees output back into the TaskOutputStore, and reports completion
    // — a single capture+completion path (no tmux wait-for). The pane is left
    // Open on completion so the user can inspect output in place (Q13).
    const command = buildWrapperCommand({
      zapsCommand: session.deps.zapsCommand,
      sessionId: session.deps.sessionId,
      runId,
    });
    try {
      if (!session.taskExecution.accepting) {
        throw new SessionClosingError();
      }
      await terminal.runTaskInPane(
        {
          taskKey: key,
          runId,
          target,
          execution: {
            unitId: key,
            generation: 0,
            command,
            cwd,
            env,
            placement: "default",
            raw: false,
          },
        },
        { id: runId, cwd, env, signal: new AbortController().signal },
      );
    } catch {
      session.paneRunInfo.delete(runId);
      session.taskOutput.finish(runId, "error", Date.now());
      completePaneRun(session, runId, key, taskName, "error");
      return ipcErr(req.id, "tmux_failed");
    }

    return ipcOk(req.id, { runId, paneId: session.panesByRun.get(runId) });
  },

  async "exec-task.resolve"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { runId } = req.params as { runId: string };
    const info = session.paneRunInfo.get(runId);
    if (!session.taskExecution.accepting) {
      return ipcErr(req.id, "session_closing", "session_closing");
    }
    if (!info) {
      return ipcErr(req.id, "not_found");
    }
    // Return only what the wrapper needs to spawn; keep the entry (taskKey/
    // TaskName) until exit so the run can be completed then.
    return ipcOk(req.id, {
      command: info.command,
      cwd: info.cwd,
      env: { ...info.env },
    });
  },

  async "exec-task.line"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { runId, line } = req.params as { runId: string; line: string };
    session.taskOutput.append(runId, line);
    return ipcOk(req.id, { ok: true });
  },

  async "exec-task.exited"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { runId, code } = req.params as { runId: string; code: number };
    const info = session.paneRunInfo.get(runId);
    if (!info) {
      // Already completed (or never registered) — nothing to finish.
      return ipcOk(req.id, { ok: true });
    }
    session.paneRunInfo.delete(runId);
    const result = code === 0 ? "success" : "error";
    session.taskOutput.finish(runId, result, Date.now());
    completePaneRun(session, runId, info.taskKey, info.taskName, result);
    return ipcOk(req.id, { ok: true });
  },

  async "tasks.output"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const { runId } = req.params as { runId: string };
    const snapshot = session.taskOutput.get(runId);
    if (!snapshot) {
      return ipcErr(req.id, "not_found");
    }
    return ipcOk(req.id, snapshot);
  },

  async "exec-service.resolve"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const parsed = wrapperIdentitySchema.safeParse(req.params);
    if (!parsed.success) {
      return ipcErr(req.id, "Invalid wrapper identity");
    }
    const { service } = parsed.data;
    const info = serviceWrappers(session).resolve(parsed.data);
    if (!info) {
      return ipcErr(req.id, `No exec info for service: ${service}`);
    }
    session.execInfo.delete(service);
    return ipcOk(req.id, {
      ...info,
      ...(serviceWrappers(session).tracks(parsed.data) ? { trackOwnership: true } : {}),
      env: { ...session.env, ...info.env },
    });
  },

  async "exec-service.started"(req, store) {
    const session = getSession(req, store);
    const parsed = wrapperStartedSchema.safeParse(req.params);
    if (!session || !parsed.success) {
      return ipcErr(req.id, "Invalid wrapper launch");
    }
    try {
      await serviceWrappers(session).started(parsed.data, parsed.data.pid, parsed.data.memberPid);
      return ipcOk(req.id, { ok: true });
    } catch {
      return ipcErr(req.id, "Wrapper launch ownership unavailable");
    }
  },

  async "exec-service.exited"(req, store) {
    const session = getSession(req, store);
    if (!session) {
      return ipcErr(req.id, "Unknown session");
    }
    const parsed = wrapperExitSchema.safeParse(req.params);
    if (!parsed.success) {
      return ipcErr(req.id, "Invalid wrapper exit");
    }
    await serviceWrappers(session).exited(parsed.data);
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
