import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { promisify } from "node:util";

import { computeBootSkip, loadConfig } from "#src/config/loader.js";
import { ipcErr, ipcOk } from "#src/lib/ipc/protocol.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { checkPortPreflight } from "#src/lib/port-preflight.js";
import { detectPorts, detectPortsForPid, getDescendantPids } from "#src/lib/port.js";
import type { ExecInfo } from "#src/lib/service/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { DetachedRegistry } from "./detached-registry.js";
import { daemonHandlers } from "./handlers/daemon.js";
import { sessionHandlers } from "./handlers/session.js";
import type { SessionCreateParams } from "./session.js";
import { Session, sessionId } from "./session.js";

const execFileAsync = promisify(execFile);

interface CreateParams {
  configPath: string;
  projectDir: string;
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
}

class DaemonServer implements SessionStore {
  private server: net.Server | null = null;
  private readonly sessions = new Map<string, Session>();
  /** In-flight `create` promises keyed by session id — collapses concurrent
   * creates for the same config into one config-load/layout/startAll (D3). */
  private readonly inFlightCreates = new Map<string, Promise<Session>>();
  /** Detached-child PID bookkeeping for orphan protection (R10). */
  private readonly detachedRegistry = new DetachedRegistry();
  public onSessionChange?: (count: number) => void;

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
   * clear the bookkeeping file. Call once at daemon startup, before any session
   * is created (R10).
   */
  public reapDetachedOrphans(): void {
    this.detachedRegistry.reapOrphans();
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
    const id = sessionId(params.configPath);

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
        const tuiPane = existing.paneMap["@tui"];
        if (tuiPane && (await existing.tmux.paneExists(tuiPane))) {
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

    // Load config
    const config = await loadConfig(params.configPath, params.projectDir);

    // Build pane layout. Boot-skip the pane for any service that is lazy
    // (P04-T02 resolved `lazyPaneByService`) AND won't autostart
    // (`flags?.start === false`). The guard-first resolution already forces
    // `lazyPaneByService=false` for `_combined` members + detached, so the
    // Skip predicate never fires for those — group/detached panes are built
    // Exactly as before.
    const skip = computeBootSkip(config);
    const { paneMap, focusPane } = await createLayout(
      params.originPane,
      config.project.layout,
      config.project.services,
      config.groups,
      { skip, tmux },
    );
    // Splitting panes off @tui can leave its kernel pty winsize stale at the
    // Pre-split width, garbling the in-process TUI until a manual resize. Force
    // Tmux to re-push every pane's winsize now that the layout is final.
    await tmux.resyncPaneSizes(paneMap["@tui"] ?? focusPane);
    await tmux.selectPane(focusPane);

    // Late-bound ref so storeExecInfo closure can capture session before it's created
    const ref: { session: Session | null } = { session: null };
    const deps = {
      sendKeys: tmux.sendKeys,
      sendCtrlC: tmux.sendCtrlC,
      panePid: tmux.panePid,
      detectPorts: async (paneTarget: string) => detectPorts(paneTarget, tmux),
      detectPortsForPid,
      capturePane: tmux.capturePane,
      getDescendantPids,
      recordDetached: (pid: number) => {
        this.detachedRegistry.record(pid);
      },
      removeDetached: (pid: number) => {
        this.detachedRegistry.remove(pid);
      },
      renameWindow: tmux.renameWindow,
      getWindowName: tmux.getWindowName,
      getWindowOption: tmux.getWindowOption,
      setWindowOption: tmux.setWindowOption,
      displayPopup: tmux.displayPopup,
      exec: async (cmd: string, args: string[], cwd?: string) => {
        await execFileAsync(cmd, args, cwd ? { cwd } : {});
      },
      preflightPorts: checkPortPreflight,
      storeExecInfo: (service: string, info: ExecInfo) => {
        ref.session?.execInfo.set(service, info);
      },
      sessionId: id,
      zapsCommand: process.env.ZAPS_COMMAND ?? "zaps",
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
    };

    // Create ServiceManager
    const { ServiceManager } = await import("#src/lib/service/manager.js");
    const manager = new ServiceManager(config, paneMap, deps, params.tmuxSession);

    const sessionParams: SessionCreateParams = {
      configPath: params.configPath,
      projectDir: params.projectDir,
      config,
      paneMap,
      tmuxSession: params.tmuxSession,
      originPane: params.originPane,
      deps,
      tmuxSocket,
      managedTmux: params.managedTmux ?? false,
    };

    const session = new Session(sessionParams, manager);
    // Create-response-only focus target; attach never returns it (E14).
    session.focusPane = focusPane;
    ref.session = session;
    this.sessions.set(id, session);
    this.onSessionChange?.(this.sessions.size);

    // Start services in background — TUI connects and sees them starting.
    // Tracked so reload/destroy can cooperatively abort and await it (A5).
    session.startPromise = session.startAll().catch(() => {
      /* Errors surfaced via stateChange */
    });

    return session;
  }

  public async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    await session.destroy();

    // Kill non-origin, non-TUI panes
    for (const paneId of Object.values(session.paneMap)) {
      if (paneId !== session.originPane && paneId !== session.paneMap["@tui"]) {
        await session.tmux.killPane(paneId).catch(() => {
          /* Best-effort cleanup */
        });
      }
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

    const response = await this.routeRequest(req, socket);
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private async routeRequest(req: IpcRequest, socket: net.Socket): Promise<IpcResponse> {
    // Daemon-level handlers
    const dHandler = daemonHandlers[req.method];
    if (dHandler) {
      try {
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
      try {
        return await sHandler(req, this, socket);
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
