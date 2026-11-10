import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TerminalOperationError } from "#src/lib/backend/terminal-error.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { DisplayPopupOptions, TmuxHandle } from "#src/lib/tmux.js";

type TerminalOwner =
  | { readonly kind: "ui"; readonly socketId: string; readonly sessionId: string }
  | { readonly kind: "task"; readonly runId: string; readonly sessionId: string };

interface OperationRequest {
  readonly owner: TerminalOwner;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

type OperationTmux = Pick<
  TmuxHandle,
  | "getSocket"
  | "listClients"
  | "displayMessage"
  | "displayPopup"
  | "closePopup"
  | "capturePaneHistory"
>;
type Client = Awaited<ReturnType<OperationTmux["listClients"]>>[number];
type PopupOptions = Omit<DisplayPopupOptions, "client" | "pane" | "cwd" | "env">;

interface TerminalOperationContext {
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
  popup(options: PopupOptions): Promise<void>;
  capture(pane: string): Promise<string>;
}

function unresolved(): never {
  throw new Error("Promise executor did not run");
}

function deferred<T>() {
  const controls: { resolve(value: T): void; reject(error: Error): void } = {
    resolve: unresolved,
    reject: unresolved,
  };
  const promise = new Promise<T>((resolve, reject) => {
    Object.assign(controls, { resolve, reject });
  });
  return { promise, ...controls };
}

async function observeCancellation(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
}

interface Lease {
  readonly id: symbol;
  readonly manager: symbol;
  readonly client: Client;
  readonly owner: TerminalOwner;
  readonly done: Promise<void>;
  quarantined?: boolean;
  cancel(): Promise<void>;
}

function sameClient(a: Client, b: Client): boolean {
  return (
    a.name === b.name &&
    a.pid === b.pid &&
    a.sessionId === b.sessionId &&
    a.sessionName === b.sessionName &&
    a.windowId === b.windowId
  );
}

function sameOwner(a: TerminalOwner, b: TerminalOwner): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.kind === b.kind &&
    (a.kind === "ui"
      ? b.kind === "ui" && a.socketId === b.socketId
      : b.kind === "task" && a.runId === b.runId)
  );
}

class TmuxTerminalLeaseRegistry {
  private readonly servers = new Map<string | null, Map<string, Lease>>();

  public forServer(socket: string | null): Map<string, Lease> {
    let leases = this.servers.get(socket);
    if (!leases) {
      leases = new Map();
      this.servers.set(socket, leases);
    }
    return leases;
  }
}

class TmuxTerminalOperations {
  private readonly leases: Map<string, Lease>;
  private readonly manager = Symbol("terminal-manager");
  private closed = false;

  private readonly tmux: OperationTmux;
  private readonly sessionName: string;
  private readonly dashboardPane: string;
  private readonly pollMs: number;

  public constructor(
    tmux: OperationTmux,
    sessionName: string,
    dashboardPane: string,
    registry: TmuxTerminalLeaseRegistry,
    pollMs = 250,
  ) {
    this.tmux = tmux;
    this.leases = registry.forServer(tmux.getSocket());
    this.sessionName = sessionName;
    this.dashboardPane = dashboardPane;
    this.pollMs = pollMs;
  }

  public async resolveClient(): Promise<Client> {
    try {
      const [identity, clients] = await Promise.all([
        this.tmux.displayMessage(
          this.dashboardPane,
          "#{session_id}\t#{session_name}\t#{window_id}",
        ),
        this.tmux.listClients(),
      ]);
      const [sessionId, sessionName, windowId] = identity.split("\t");
      const attached = clients.filter(
        (client) => client.sessionId === sessionId && client.sessionName === this.sessionName,
      );
      if (
        sessionName !== this.sessionName ||
        !sessionId ||
        !windowId ||
        attached.length !== 1 ||
        attached[0]?.windowId !== windowId
      ) {
        throw new TerminalOperationError("backend_unavailable");
      }
      return attached[0];
    } catch {
      throw new TerminalOperationError("backend_unavailable");
    }
  }

  private releaseReplacement(client: Client): void {
    const lease = this.leases.get(client.name);
    if (lease?.quarantined && lease.client.pid !== client.pid) {
      this.leases.delete(client.name);
    }
  }

  public async assertClientAvailable(): Promise<void> {
    const client = await this.resolveClient();
    if (this.closed) {
      throw new TerminalOperationError("cancelled");
    }
    this.releaseReplacement(client);
    if (this.leases.has(client.name)) {
      throw new TerminalOperationError("terminal_busy");
    }
  }

  public async run<T>(
    request: OperationRequest,
    action: (context: TerminalOperationContext) => Promise<T>,
  ): Promise<T> {
    if (this.closed || request.signal.aborted) {
      throw new TerminalOperationError("cancelled");
    }
    const env = Object.freeze({ ...request.env });
    const { cwd } = request;
    const owner = { ...request.owner };
    const client = await this.resolveClient();
    if (this.closed || request.signal.aborted) {
      throw new TerminalOperationError("cancelled");
    }
    this.releaseReplacement(client);
    if (this.leases.has(client.name)) {
      throw new TerminalOperationError("terminal_busy");
    }
    const controller = new AbortController();
    const cancelled = deferred<never>();
    const cancellation = cancelled.promise;
    void observeCancellation(cancellation);
    const id = Symbol("terminal-lease");
    let active = true;
    let presenting = false;
    let popupOpen = false;
    let cleanupUncertain = false;
    let popupCompleted = false;
    const cancellationState: { task?: Promise<void> } = {};
    const checkActive = () => {
      if (!active || controller.signal.aborted) {
        throw new TerminalOperationError("cancelled");
      }
    };
    const cancel = async (): Promise<void> => {
      if (cancellationState.task) {
        return cancellationState.task;
      }
      if (!active) {
        return Promise.resolve();
      }
      controller.abort();
      cancellationState.task = (async () => {
        try {
          if (popupOpen && this.leases.get(client.name)?.id === id) {
            const current = await this.resolveClient();
            if (active && this.leases.get(client.name)?.id === id && sameClient(current, client)) {
              // Tmux has no popup-ID close: external replacement cannot be proven safe.
              try {
                await this.tmux.closePopup(client.name);
              } catch {
                cleanupUncertain = !popupCompleted;
                const currentLease = this.leases.get(client.name);
                if (currentLease?.id === id) {
                  currentLease.quarantined = cleanupUncertain;
                }
              }
            }
          }
        } catch {
          // A vanished session/client has no owned popup left to close.
        } finally {
          cancelled.reject(
            new TerminalOperationError(cleanupUncertain ? "terminal_busy" : "cancelled"),
          );
        }
      })();
      return cancellationState.task;
    };
    const completion = deferred<void>();
    void observeCancellation(completion.promise);
    const lease: Lease = {
      id,
      manager: this.manager,
      client,
      owner,
      cancel,
      done: completion.promise,
    };
    this.leases.set(client.name, lease);
    const onAbort = () => {
      void cancel();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      void cancel();
    }
    let checking = false;
    const checkClient = async () => {
      if (checking || !active || controller.signal.aborted) {
        return;
      }
      checking = true;
      try {
        const current = await this.resolveClient();
        if (!sameClient(current, client)) {
          await cancel();
        }
      } catch {
        await cancel();
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => {
      void checkClient();
    }, this.pollMs);
    timer.unref();
    let directory: string | undefined = undefined;
    const cleanup = async () => {
      try {
        if (directory) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        const cleanupError = new TerminalOperationError("backend_unavailable", presenting, {
          cause: error,
        });
        completion.reject(cleanupError);
        throw cleanupError;
      } finally {
        if (!cleanupUncertain && this.leases.get(client.name)?.id === id) {
          this.leases.delete(client.name);
        }
        completion.resolve();
      }
    };
    try {
      directory = await mkdtemp(path.join(os.tmpdir(), "zaps-terminal-"));
      checkActive();
      const context: TerminalOperationContext = {
        directory,
        env,
        cwd,
        signal: controller.signal,
        popup: async (options) => {
          checkActive();
          if (presenting) {
            throw new TerminalOperationError("terminal_busy");
          }
          const current = await this.resolveClient();
          checkActive();
          if (!sameClient(current, client)) {
            throw new TerminalOperationError("backend_unavailable");
          }
          if (presenting) {
            throw new TerminalOperationError("terminal_busy");
          }
          presenting = true;
          popupOpen = true;
          await Promise.race([
            this.tmux
              .displayPopup({
                ...options,
                client: client.name,
                pane: this.dashboardPane,
                env: { ...env },
                cwd,
              })
              .then(() => {
                popupCompleted = true;
                if (cleanupUncertain && this.leases.get(client.name)?.id === id) {
                  this.leases.delete(client.name);
                }
                return undefined;
              }),
            cancellation,
          ]);
          popupOpen = false;
          checkActive();
        },
        capture: async (pane) => {
          checkActive();
          return this.tmux.capturePaneHistory(pane);
        },
      };
      const result = await Promise.race([action(context), cancellation]);
      checkActive();
      return result;
    } catch (error) {
      let code: TerminalOperationError["code"] = "backend_unavailable";
      if (controller.signal.aborted) {
        code = "cancelled";
      } else if (error instanceof TerminalOperationError) {
        ({ code } = error);
      }
      if (popupOpen) {
        await cancel();
      }
      throw new TerminalOperationError(cleanupUncertain ? "terminal_busy" : code, presenting, {
        cause: error,
      });
    } finally {
      if (popupOpen) {
        await cancel();
      }
      active = false;
      clearInterval(timer);
      request.signal.removeEventListener("abort", onAbort);
      await cancellationState.task;
      await cleanup();
    }
  }

  public async cancelOwner(owner: TerminalOwner): Promise<void> {
    await Promise.all(
      [...this.leases.values()]
        .filter((lease) => lease.manager === this.manager && sameOwner(owner, lease.owner))
        .map(async (lease) => {
          await lease.cancel();
          await lease.done;
        }),
    );
  }

  public async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.leases.values()]
        .filter((lease) => lease.manager === this.manager)
        .map(async (lease) => {
          await lease.cancel();
          await lease.done;
        }),
    );
  }
}

async function editOperationCapture(
  context: TerminalOperationContext,
  pane: string,
  title: string,
): Promise<void> {
  const content = await context.capture(pane);
  context.signal.throwIfAborted();
  const file = path.join(context.directory, "capture");
  await writeFile(file, content, "utf8");
  await context.popup({
    command: `sh -c ${shellEscape(`${context.env.EDITOR || "vim"} ${shellEscape(file)}`)}`,
    title,
    width: "90%",
    height: "90%",
  });
}

export {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
  TerminalOperationError,
  editOperationCapture,
};
export type { TerminalOwner, OperationRequest, OperationTmux, TerminalOperationContext };
