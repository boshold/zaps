import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { promisify } from "node:util";

import { computeBootSkip } from "#src/config/loader.js";
import { loadProjectContext } from "#src/config/project-context.js";
import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
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
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { checkPortPreflight } from "#src/lib/port-preflight.js";
import { detectPorts, detectPortsForPid, getDescendantPids } from "#src/lib/port.js";
import { captureEnvironment, parseRequestContext } from "#src/lib/request-context.js";
import { sanitizeSegment } from "#src/lib/sentra/config.js";
import { ErrorCounter } from "#src/lib/sentra/counter.js";
import { SentraHost } from "#src/lib/sentra/host.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { ServiceManagerDeps } from "#src/lib/service/manager.js";
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

interface CreateParams {
  configPath: string;
  /** Directory where zaps was invoked. */
  projectDir: string;
  /** Project root resolved by the caller. */
  resolvedProjectDir?: string;
  shellEnv?: Record<string, string>;
  tmuxSession: string;
  originPane: string;
  /** Tmux socket hosting the session; omitted/null = the user's default server. */
  tmuxSocket?: string | null;
  /** True when zaps owns the hosting tmux session. Validated at the IPC boundary. */
  managedTmux?: boolean;
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

function assertSameTmuxContext(existing: Session, params: CreateParams): void {
  const requestedSocket = params.tmuxSocket ?? null;
  const requestedManaged = params.managedTmux === true;
  const host = existing.backend.getPresentation();
  if (host.kind !== "tmux") {
    throw new Error("Session already running without a tmux host. Run zaps down first.");
  }
  if (host.tmuxSocket === requestedSocket && host.managedTmux === requestedManaged) {
    return;
  }
  throw new Error(
    `Session already running on ${describeTmuxContext(host.tmuxSocket, host.managedTmux)}; ` +
      `this request asked for ${describeTmuxContext(requestedSocket, requestedManaged)}. ` +
      `Run zaps down first.`,
  );
}

class DaemonServer implements SessionStore {
  private readonly terminalLeases = new TmuxTerminalLeaseRegistry();
  private server: net.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  /** In-flight `create` promises keyed by session id — collapses concurrent
   * creates for the same config into one config-load/layout/startAll (D3). */
  private readonly inFlightCreates = new Map<string, Promise<Session>>();
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

  public async create(params: CreateParams): Promise<Session> {
    const id = sessionId(params.configPath, params.resolvedProjectDir ?? params.projectDir);

    // Collapse concurrent creates for the same id onto one in-flight build so a
    // Single config load / layout / startAll runs and no loser leaks panes (D3).
    const inflight = this.inFlightCreates.get(id);
    if (inflight) {
      return inflight;
    }

    const promise = this.resolveCreate(id, params);
    this.inFlightCreates.set(id, promise);
    return promise;
  }

  /**
   * Reuse a live cached session, else (re)build. A cache hit whose `@tui` pane
   * was killed externally is fully destroyed and rebuilt with the caller's
   * origin pane, so a re-`up` after closing the window starts clean (A4). The
   * in-flight entry is cleared on settle — including failure — so a later
   * create retries instead of joining a dead promise (D3).
   */
  private async resolveCreate(id: string, params: CreateParams): Promise<Session> {
    try {
      const existing = this.sessions.get(id);
      if (existing) {
        assertSameTmuxContext(existing, params);
        if ((await existing.backend.health()) === "alive") {
          return existing;
        }
        // The tmux window was closed externally — full teardown, then rebuild.
        await this.destroy(id);
      }
      return await this.buildSession(id, params);
    } finally {
      this.inFlightCreates.delete(id);
    }
  }

  private async buildSession(id: string, params: CreateParams): Promise<Session> {
    // Every tmux command for this session goes through one socket-bound handle.
    // The Session builds an identical one from `tmuxSocket`; this one covers the
    // Layout build that has to happen before the Session exists.
    const tmuxSocket = params.tmuxSocket ?? null;
    const tmux = tmuxFor(tmuxSocket);

    const loaded = await loadProjectContext(
      params.configPath,
      params.projectDir,
      params.shellEnv ?? captureEnvironment(),
    );
    const { config } = loaded;
    const resolvedId = sessionId(params.configPath, config.projectDir);
    if (params.resolvedProjectDir !== undefined && resolvedId !== id) {
      throw new Error("Resolved project directory does not match the request context");
    }
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
    const ref: { session: Session | null } = { session: null };
    const operations = new TmuxTerminalOperations(
      tmux,
      params.tmuxSession,
      params.originPane,
      this.terminalLeases,
    );
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
      disposeRuntime: async () => {
        const errors: unknown[] = [];
        for (const dispose of [
          async () => operations.dispose(),
          async () => terminal.dispose(),
          async () => runtime.dispose(),
        ]) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw new AggregateError(errors, "Backend resource cleanup incomplete");
        }
      },

      layout: config.project.layout,
      services: config.project.services,
      groups: config.groups,
      skip: computeBootSkip(config),
    });
    backendRef.current = backend;
    backend.subscribePresentation((view) => {
      if (view.kind === "tmux") {
        runtime.retainPanes(new Set(Object.values(view.paneMap)));
      }
    });
    try {
      await backend.activateWindowTitles();
      const view = backend.getPresentation();
      if (view.kind !== "tmux") {
        throw new Error("Expected tmux presentation");
      }
      const paneMap = { ...view.paneMap };

      // Late-bound ref so storeExecInfo closure can capture session before it's created
      const deps: ServiceManagerDeps = {
        runtime: () => runtime,
        inspectPorts: async (pid) => createProcessInspection().detectPortsForPid(pid),
        sendKeys: tmux.sendKeys,
        sendCtrlC: tmux.sendCtrlC,
        panePid: tmux.panePid,
        detectPorts: async (paneTarget: string) => detectPorts(paneTarget, tmux),
        detectPortsForPid,
        capturePane: tmux.capturePane,
        getDescendantPids,
        recordDetached: async (pid: number) => this.detachedRegistry.record(pid),
        removeDetached: async (pid: number) => this.detachedRegistry.remove(pid),
        renameWindow: tmux.renameWindow,
        getWindowName: tmux.getWindowName,
        getWindowOption: tmux.getWindowOption,
        setWindowOption: tmux.setWindowOption,
        displayPopup: tmux.displayPopup,
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
        // Reflow hooks late-bind to the session (same ref pattern as
        // `storeExecInfo`). They always invoke `session.reflowInsert/Remove`,
        // Which wrap `withOpLock` around the LIVE-getter `Session.reflow`. After
        // A reload, `ref.session` is the same Session instance but
        // `session.paneMap`/`session.config` have been atomically swapped — the
        // Reflow's live getters pick that up without any reconstruction here.
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

      // Create ServiceManager
      const { ServiceManager } = await import("#src/lib/service/manager.js");
      const manager = new ServiceManager(config, paneMap, deps, params.tmuxSession);

      const sessionParams: SessionCreateParams = {
        backend,
        paneMap,
        configPath: params.configPath,
        projectDir: params.projectDir,
        config,
        deps,
        reloadPresentation: async (candidate) =>
          backend.reload(candidate, computeBootSkip(candidate)),
        insertPresentation: async (name) => backend.insertPane(name),
        removePresentation: async (name) => backend.removePane(name),
        updatePresentationTitle: async (statuses) => backend.updateServiceTitle(statuses),
        shellEnv: params.shellEnv,
        env: loaded.env,
      };

      const session = new Session(sessionParams, manager);
      ref.session = session;
      bindServiceWrappers(session, wrappers);
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
      const results = await Promise.allSettled([processes.dispose(), backend.dispose()]);
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
