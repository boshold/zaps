import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { computeBootSkip } from "#src/config/loader.js";
import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedProjectContext } from "#src/config/project-context.js";
import { backendFactories } from "#src/lib/backend/factory.js";
import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { normalizeLegacySessionCreateParams } from "#src/lib/backend/schemas.js";
import type { SessionCreateParams as BackendCreateParams } from "#src/lib/backend/schemas.js";
import { TmuxTerminalDriver } from "#src/lib/backend/tmux/driver.js";
import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import {
  TmuxRuntime,
  bindServiceWrappers,
  serviceWrappers,
} from "#src/lib/backend/tmux/runtime.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { SessionBackend } from "#src/lib/backend/types.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { checkPortPreflight } from "#src/lib/port-preflight.js";
import { detectPorts, detectPortsForPid, getDescendantPids } from "#src/lib/port.js";
import { captureEnvironment, parseRequestContext } from "#src/lib/request-context.js";
import { sanitizeSegment } from "#src/lib/sentra/config.js";
import { ErrorCounter } from "#src/lib/sentra/counter.js";
import { SentraHost } from "#src/lib/sentra/host.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { ServiceManager, ServiceManagerRuntimeDeps } from "#src/lib/service/manager.js";
import type { ExecInfo } from "#src/lib/service/types.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { DetachedRegistry } from "./detached-registry.js";
import { daemonHandlers } from "./handlers/daemon.js";
import { sessionHandlers } from "./handlers/session.js";
import { daemonDir } from "./lifecycle.js";
import type { SessionCreateParams } from "./session.js";
import { Session, sessionId } from "./session.js";

const execFileAsync = promisify(execFile);

function writeEnvironmentFile(env: Record<string, string>): string {
  const filePath = `${daemonDir()}/env-${randomUUID()}`;
  const lines = Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
    .map(([key, value]) => `export ${key}=${shellEscape(value)}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

const CONTEXT_MUTATING_METHODS = new Set([
  "session.reload",
  "services.start",
  "services.stop",
  "services.restart",
  "services.rebuild",
  "services.startAll",
  "services.stopAll",
  "services.restartAll",
  "tasks.run",
  "tasks.runInPane",
]);

type CreateParams = (
  | BackendCreateParams
  | Omit<Extract<BackendCreateParams, { backend: "tmux" }>, "backend">
) & {
  shellEnv?: Record<string, string>;
};
type CapturedCreateParams = BackendCreateParams & { shellEnv: Record<string, string> };
type CreationIdentity =
  | { backend: "shell" }
  | {
      backend: "tmux";
      tmuxSocket: string | null;
      managedTmux: boolean;
    };
interface PendingCreate {
  identity: CreationIdentity;
  promise: Promise<Session>;
}

class BackendConflictError extends Error {
  public readonly code = "backend_conflict";
  public override readonly name = "BackendConflictError";
}

function creationIdentity(params: BackendCreateParams): CreationIdentity {
  return params.backend === "shell"
    ? { backend: "shell" }
    : {
        backend: "tmux",
        tmuxSocket: params.tmuxSocket ?? null,
        managedTmux: params.managedTmux === true,
      };
}

/**
 * A cache hit must not silently hand back a session living somewhere else: the
 * caller's panes, ports and teardown all assume the socket it asked for. Two
 * zaps in different tmux contexts (personal vs managed) sharing a config path
 * would otherwise "succeed" and then drive tmux commands at the wrong server.
 */
function describeTmuxContext(socket: string | null, managed: boolean): string {
  const where = socket === null ? "the default tmux server" : `tmux socket '${socket}'`;
  return managed ? `${where} (managed)` : where;
}

function assertCompatible(existing: CreationIdentity, requested: CreationIdentity): void {
  if (existing.backend !== requested.backend) {
    throw new BackendConflictError(
      `Session already running with backend '${existing.backend}'; this request asked for '${requested.backend}'. Run zaps down first.`,
    );
  }
  if (
    existing.backend === "tmux" &&
    requested.backend === "tmux" &&
    (existing.tmuxSocket !== requested.tmuxSocket || existing.managedTmux !== requested.managedTmux)
  ) {
    throw new BackendConflictError(
      `Session already running on ${describeTmuxContext(existing.tmuxSocket, existing.managedTmux)}; ` +
        `this request asked for ${describeTmuxContext(requested.tmuxSocket, requested.managedTmux)}. Run zaps down first.`,
    );
  }
}

interface SessionStore {
  list(): Session[];
  get(id: string): Session | undefined;
  getByProjectDir(dir: string): Session | undefined;
  create(params: CreateParams): Promise<Session>;
  destroy(id: string): Promise<void>;
  /** Daemon-wide Sentra host (one per daemon, started lazily). */
  readonly sentra: SentraHost;
  /** Per-session error counts and live `sentra.*` broadcast. */
  readonly sentraCounter: ErrorCounter;
}

interface DaemonServerOptions {
  sentraHost?: SentraHost;
  /** Daemon log line writer. */
  log?: (msg: string) => void;
}

class DaemonServer implements SessionStore {
  private readonly terminalLeases = new TmuxTerminalLeaseRegistry();
  private server: net.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  /** In-flight `create` promises keyed by session id — collapses concurrent
   * creates for the same config into one config-load/layout/startAll (D3). */
  private readonly inFlightCreates = new Map<string, PendingCreate>();
  private readonly preparations = new Map<string, PendingCreate>();
  /** Detached-child PID bookkeeping for orphan protection (R10). */
  private readonly detachedRegistry = new DetachedRegistry();
  public onSessionChange?: (count: number) => void;
  public readonly sentra: SentraHost;
  public readonly sentraCounter: ErrorCounter;
  private readonly log?: (msg: string) => void;

  public constructor(options: DaemonServerOptions = {}) {
    this.sentra = options.sentraHost ?? new SentraHost({ logger: options.log });
    this.sentraCounter = new ErrorCounter(this.sentra);
    this.log = options.log;
  }

  public async start(socketPath: string): Promise<void> {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() !== "") {
              void this.handleLine(line, socket);
            }
          }
        });
        const cleanupSubscriptions = () => {
          for (const session of this.sessions.values()) {
            session.removeSubscriber(socket);
          }
        };
        socket.on("error", cleanupSubscriptions);
        socket.on("close", cleanupSubscriptions);
      });

      this.server.on("error", reject);
      this.server.listen(socketPath, () => {
        resolve();
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Reap detached children orphaned by a previous daemon's crash/SIGKILL, then
   * retain unresolved ownership evidence. Call before any session
   * is created (R10).
   */
  public async reapDetachedOrphans(): Promise<void> {
    await this.detachedRegistry.reapOrphans();
  }

  // --- SessionStore ---

  public list(): Session[] {
    return [...this.sessions.values()];
  }

  public get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  public getByProjectDir(dir: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.projectDir === dir) {
        return s;
      }
    }
    return undefined;
  }

  public async create(input: CreateParams): Promise<Session> {
    const { shellEnv, ...request } = input;
    const params: CapturedCreateParams = {
      ...normalizeLegacySessionCreateParams(request),
      shellEnv: { ...(shellEnv ?? captureEnvironment()) },
    };
    const identity = creationIdentity(params);
    const key = JSON.stringify([
      path.resolve(params.configPath),
      path.resolve(params.projectDir),
      params.resolvedProjectDir === undefined ? null : path.resolve(params.resolvedProjectDir),
      Object.entries(params.shellEnv).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return DaemonServer.reserve(this.preparations, key, identity, async () => {
      const loaded = await loadProjectContext(
        params.configPath,
        params.projectDir,
        params.shellEnv,
      );
      const id = sessionId(params.configPath, loaded.config.projectDir);
      if (
        params.resolvedProjectDir !== undefined &&
        sessionId(params.configPath, params.resolvedProjectDir) !== id
      ) {
        throw new Error("Resolved project directory does not match the request context");
      }
      return DaemonServer.reserve(this.inFlightCreates, id, identity, async () =>
        this.resolveCreate(id, params, loaded),
      );
    });
  }

  private static async reserve(
    records: Map<string, PendingCreate>,
    key: string,
    identity: CreationIdentity,
    action: () => Promise<Session>,
  ): Promise<Session> {
    const pending = records.get(key);
    if (pending) {
      assertCompatible(pending.identity, identity);
      return pending.promise;
    }
    const record: PendingCreate = {
      identity,
      promise: Promise.resolve()
        .then(action)
        .finally(() => {
          if (records.get(key) === record) {
            records.delete(key);
          }
        }),
    };
    records.set(key, record);
    return record.promise;
  }

  private async resolveCreate(
    id: string,
    params: CapturedCreateParams,
    loaded: ResolvedProjectContext,
  ): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) {
      const host = existing.backend.getPresentation();
      assertCompatible(
        host.kind === "shell"
          ? { backend: "shell" }
          : {
              backend: "tmux",
              tmuxSocket: host.tmuxSocket,
              managedTmux: host.managedTmux,
            },
        creationIdentity(params),
      );
      if ((await existing.backend.health()) === "alive") {
        return existing;
      }
      await this.destroy(id);
    }
    return this.buildSession(id, params, loaded);
  }

  private async prepareTmux(
    id: string,
    params: Extract<CapturedCreateParams, { backend: "tmux" }>,
    loaded: ResolvedProjectContext,
    ref: { session: Session | null },
  ) {
    const { config } = loaded;
    const tmuxSocket = params.tmuxSocket ?? null;
    const tmux = tmuxFor(tmuxSocket);
    const tmuxWindow = await tmux.displayMessage(params.originPane, "#{window_id}");
    const wrappers = serviceWrappers({});
    const processes = new ProcessRunner({
      onLines: () => {
        /* Runtime events own output. */
      },
      onExit: () => {
        /* Runtime events own exits. */
      },
      record: async (pid) => this.detachedRegistry.record(pid),
      unrecord: async (pid) => this.detachedRegistry.remove(pid),
    });
    const cleanup: (() => Promise<void>)[] = [async () => processes.dispose()];
    let disposal: Promise<void> | undefined = undefined;
    const disposeResources = async (): Promise<void> => {
      disposal ??= (async () => {
        const results = await Promise.allSettled(cleanup.map(async (dispose) => dispose()));
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length) {
          throw new AggregateError(failures, "Backend resource cleanup incomplete");
        }
      })();
      await disposal;
    };
    let prepared: TmuxSessionBackend | undefined = undefined;
    try {
      const operations = new TmuxTerminalOperations(
        tmux,
        params.tmuxSession,
        params.originPane,
        this.terminalLeases,
      );
      cleanup.push(async () => operations.dispose());
      const backendRef: { current: TmuxSessionBackend | null } = { current: null };
      const runtime = new TmuxRuntime({
        tmux,
        processes,
        wrappers,
        sessionId: id,
        environmentFile: writeEnvironmentFile,
        removeEnvironmentFile: (file) => fs.rmSync(file, { force: true }),
        zapsCommand: process.env.ZAPS_COMMAND ?? "zaps",
        paneFor: (name) => {
          if (!backendRef.current) {
            throw new Error("Backend not initialized");
          }
          return backendRef.current.paneFor(name);
        },
      });
      // Runtime now owns process cleanup.
      cleanup.shift();
      cleanup.push(async () => runtime.dispose());
      const terminal = new TmuxTerminalDriver({
        sessionId: id,
        sessionName: params.tmuxSession,
        taskPane: (runId, pane) => ref.session?.panesByRun.set(runId, pane),
        tmux,
        dashboardPane: params.originPane,
        operations,
        paneFor: (name) => {
          if (!backendRef.current) {
            throw new Error("Backend not initialized");
          }
          return backendRef.current.paneFor(name);
        },
        tasks: () =>
          Object.entries(ref.session?.config.project.tasks ?? {}).map(([key, task]) => ({
            key,
            name: task.name,
          })),
        output: (runId) => ref.session?.taskOutput.get(runId) ?? undefined,
        reconcile: async (layout) => {
          if (!backendRef.current) {
            throw new Error("Backend not initialized");
          }
          await backendRef.current.reconcileLayout(layout);
        },
      });
      cleanup.splice(-1, 0, async () => terminal.dispose());
      const backend = await TmuxSessionBackend.create({
        host: {
          tmuxSession: params.tmuxSession,
          tmuxWindow,
          originPane: params.originPane,
          tmuxSocket,
          managedTmux: params.managedTmux ?? false,
        },
        tmux,
        runtime,
        terminal,
        disposeRuntime: disposeResources,

        layout: config.project.layout,
        services: config.project.services,
        groups: config.groups,
        skip: computeBootSkip(config),
      });
      prepared = backend;
      backendRef.current = backend;
      backend.subscribePresentation((view) => {
        if (view.kind === "tmux") {
          runtime.retainPanes(new Set(Object.values(view.paneMap)));
        }
      });
      await backend.activateWindowTitles();
      return {
        backend,
        wrappers,
        deps: {
          sendKeys: tmux.sendKeys,
          sendCtrlC: tmux.sendCtrlC,
          panePid: tmux.panePid,
          detectPorts: async (paneTarget: string) => detectPorts(paneTarget, tmux),
          capturePane: tmux.capturePane,
          renameWindow: tmux.renameWindow,
          getWindowName: tmux.getWindowName,
          getWindowOption: tmux.getWindowOption,
          setWindowOption: tmux.setWindowOption,
          displayPopup: tmux.displayPopup,
        },
        presentation: {
          reloadPresentation: async (candidate: ResolvedProjectContext["config"]) =>
            backend.reload(candidate, computeBootSkip(candidate)),
          insertPresentation: async (name: string) => backend.insertPane(name),
          removePresentation: async (name: string) => backend.removePane(name),
          updatePresentationTitle: async (
            statuses: Parameters<TmuxSessionBackend["updateServiceTitle"]>[0],
          ) => backend.updateServiceTitle(statuses),
        },
      };
    } catch (error) {
      const [result] = await Promise.allSettled([
        (async () => (prepared ? prepared.dispose() : disposeResources()))(),
      ]);
      if (result.status === "rejected") {
        throw new AggregateError([error, result.reason], "Session construction cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async buildSession(
    id: string,
    params: CapturedCreateParams,
    loaded: ResolvedProjectContext,
  ): Promise<Session> {
    const { config } = loaded;
    const ref: { session: Session | null } = { session: null };
    const tmux =
      params.backend === "tmux" ? await this.prepareTmux(id, params, loaded, ref) : undefined;
    const backend: SessionBackend =
      tmux?.backend ??
      (await backendFactories.shell({
        services: config.project.services,
        layout: config.project.layout,
        processes: {
          record: async (pid) => this.detachedRegistry.record(pid),
          unrecord: async (pid) => this.detachedRegistry.remove(pid),
        },
      }));
    let manager: ServiceManager | undefined = undefined;
    try {
      const view = backend.getPresentation();
      const paneMap = view.kind === "tmux" ? { ...view.paneMap } : {};
      const deps: ServiceManagerRuntimeDeps = {
        ...tmux?.deps,
        runtime: () => backend.runtime,
        inspectPorts: async (pid) => createProcessInspection().detectPortsForPid(pid),
        detectPortsForPid,
        getDescendantPids,
        recordDetached: async (pid: number) => this.detachedRegistry.record(pid),
        removeDetached: async (pid: number) => this.detachedRegistry.remove(pid),
        exec: async (cmd: string, args: string[], cwd?: string) => {
          await execFileAsync(cmd, args, {
            ...(cwd ? { cwd } : {}),
            env: captureEnvironment(),
          });
        },
        preflightPorts: checkPortPreflight,
        storeExecInfo: (service: string, info: ExecInfo, executionId?: string) => {
          const { session } = ref;
          if (!session || !executionId) {
            throw new Error("Missing wrapper registration");
          }
          session.execInfo.set(service, info);
        },
        sessionId: id,
        zapsCommand: process.env.ZAPS_COMMAND ?? "zaps",
        environment: () => ({ ...(ref.session?.env ?? loaded.env) }),
        environmentFile: writeEnvironmentFile,
        removeEnvironmentFile: (filePath: string) => {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* Already consumed or unavailable. */
          }
        },
        // Session serializes adapter layout mutations against reload/destroy.
        reflowInsert: async (name: string) => {
          if (!ref.session) {
            throw new Error("reflowInsert: session not yet wired");
          }
          await ref.session.reflowInsert(name);
        },
        reflowRemove: async (name: string) => {
          if (!ref.session) {
            throw new Error("reflowRemove: session not yet wired");
          }
          await ref.session.reflowRemove(name);
        },
        sentra: {
          host: this.sentra,
          get project() {
            return sanitizeSegment((ref.session?.config ?? config).project.name);
          },
          session: id,
          projectDir: config.projectDir,
          log: this.log,
          onEnvBuilt: () => {
            try {
              this.sentraCounter.attach(id, (event) => ref.session?.broadcast(event));
            } catch (error) {
              this.log?.(`sentra: cannot subscribe session ${id}: ${String(error)}`);
            }
          },
          onServiceStart: (service: string, startedAt: number) => {
            this.sentraCounter.reset(id, service, startedAt);
          },
        },
      };

      const { ServiceManager } = await import("#src/lib/service/manager.js");
      manager = new ServiceManager(
        config,
        paneMap,
        deps,
        params.backend === "tmux" ? params.tmuxSession : undefined,
      );

      const sessionParams: SessionCreateParams = {
        backend,
        paneMap,
        configPath: params.configPath,
        projectDir: params.projectDir,
        config,
        deps,
        ...tmux?.presentation,
        shellEnv: params.shellEnv,
        env: loaded.env,
      };

      const session = new Session(sessionParams, manager);
      ref.session = session;
      if (tmux) {
        bindServiceWrappers(session, tmux.wrappers);
      }
      this.sessions.set(id, session);
      this.onSessionChange?.(this.sessions.size);

      // Start services in background — TUI connects and sees them starting.
      // Tracked so reload/destroy can cooperatively abort and await it (A5).
      session.startPromise = session.runWithContext(async () => {
        try {
          await session.startAll();
        } catch {
          /* Errors surfaced via stateChange */
        }
      });

      return session;
    } catch (error) {
      const { session } = ref;
      if (session && this.sessions.get(id) === session) {
        this.sessions.delete(id);
      }
      const results = await Promise.allSettled([
        (async () => this.sentraCounter.detach(id))(),
        (async () => {
          if (session) {
            await session.destroy();
          } else {
            manager?.disposeObservers();
          }
        })(),
        ...(session ? [] : [(async () => backend.dispose())()]),
      ]);
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Session construction cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    try {
      await session.destroy();
    } finally {
      this.sentraCounter.detach(id);
    }

    this.sessions.delete(id);
    this.onSessionChange?.(this.sessions.size);
  }

  // --- Request routing ---

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IpcRequest = { id: "?", method: "" };
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: "?", error: "Invalid JSON" })}\n`);
      return;
    }

    const subscription: { acknowledge?: () => void } = {};
    const response = await this.routeRequest(req, socket, (acknowledge) => {
      subscription.acknowledge = acknowledge;
    });
    if (socket.destroyed || !socket.writable) {
      return;
    }
    // eslint-disable-next-line prefer-await-to-callbacks -- acknowledgement follows socket flush
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (!error && response.error === undefined && req.session) {
        subscription.acknowledge?.();
      }
    });
  }

  private async routeRequest(
    req: IpcRequest,
    socket: net.Socket,
    onSubscription: (acknowledge: () => void) => void,
  ): Promise<IpcResponse> {
    // Daemon-level handlers
    const dHandler = daemonHandlers[req.method];
    if (dHandler) {
      try {
        if (req.method === "session.create" && !req.context) {
          return ipcErr(req.id, "request context required; restart zaps with the current CLI");
        }
        return await dHandler(req, this);
      } catch (error) {
        return ipcErr(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Session-scoped handlers
    const sHandler = sessionHandlers[req.method];
    if (sHandler) {
      if (!req.session) {
        return ipcErr(req.id, `Session required for method: ${req.method}`);
      }
      const session = this.get(req.session);
      if (!session) {
        return ipcErr(req.id, "Unknown session");
      }
      try {
        if (CONTEXT_MUTATING_METHODS.has(req.method)) {
          if (!req.context) {
            return ipcErr(req.id, "request context required; restart zaps with the current CLI");
          }
          session.updateContext(parseRequestContext(req.context).env);
        }
        return await session.runWithContext(async () => {
          const response = sHandler(req, this, socket);
          if (req.method === "subscribe") {
            onSubscription(session.subscriberAcknowledgement(socket));
          } else if (
            req.method === "session.attach" &&
            req.params &&
            typeof req.params === "object" &&
            "ui" in req.params &&
            req.params.ui === true
          ) {
            onSubscription(session.uiBindingAcknowledgement(socket));
          }
          return response;
        });
      } catch (error) {
        return ipcErr(req.id, error instanceof Error ? error.message : String(error));
      }
    }

    // Backward compat: bare "ping" → daemon.ping
    if (req.method === "ping") {
      return ipcOk(req.id, "pong");
    }

    return ipcErr(req.id, `Unknown method: ${req.method}`);
  }
}

export { DaemonServer };
export type { SessionStore };
