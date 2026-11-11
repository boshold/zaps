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
  | "detachClient"
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
  cleanup(): Promise<void>;
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

async function settleLease(lease: Lease): Promise<void> {
  await lease.cancel();
  await observeCancellation(lease.done);
  await lease.cleanup();
}

class TmuxTerminalLeaseRegistry {
  public readonly detaching = new Set<string>();
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
  private readonly registry: TmuxTerminalLeaseRegistry;
  private readonly server: string;
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
    this.registry = registry;
    this.server = JSON.stringify(tmux.getSocket());
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

  private async releaseReplacement(client: Client): Promise<void> {
    const lease = this.leases.get(client.name);
    if (lease?.quarantined && lease.client.pid !== client.pid) {
      await lease.cleanup();
    }
  }

  public async assertClientAvailable(): Promise<void> {
    const client = await this.resolveClient();
    await this.releaseReplacement(client);
    if (this.closed) {
      throw new TerminalOperationError("cancelled");
    }
    if (this.leases.has(client.name) || this.registry.detaching.has(this.detachKey(client))) {
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
    await this.releaseReplacement(client);
    if (this.closed || request.signal.aborted) {
      throw new TerminalOperationError("cancelled");
    }
    if (this.leases.has(client.name) || this.registry.detaching.has(this.detachKey(client))) {
      throw new TerminalOperationError("terminal_busy");
    }
    const controller = new AbortController();
    const cancelled = deferred<never>();
    const cancellation = cancelled.promise;
    void observeCancellation(cancellation);
    const id = Symbol("terminal-lease");
    let active = true;
    let presenting = false;
    let preparing = false;
    let popupOpen = false;
    let cleanupUncertain = false;
    let popupCompleted = false;
    const cleanupCauses: unknown[] = [];
    const cancellationState: { task?: Promise<void> } = {};
    let cancellationCause: "owner" | "client" = "owner";
    const cancellationCode = (): "cancelled" | "backend_unavailable" =>
      cancellationCause === "client" && !presenting ? "backend_unavailable" : "cancelled";
    const checkActive = () => {
      if (!active || controller.signal.aborted) {
        throw new TerminalOperationError("cancelled");
      }
    };
    const cancel = async (cause: "owner" | "client" = "owner"): Promise<void> => {
      if (cancellationState.task) {
        if (cause === "owner") {
          cancellationCause = cause;
        }
        return cancellationState.task;
      }
      if (!active) {
        return Promise.resolve();
      }
      cancellationCause = cause;
      controller.abort();
      cancellationState.task = (async () => {
        try {
          if (popupOpen && this.leases.get(client.name)?.id === id) {
            const current = await this.resolveClient();
            if (active && this.leases.get(client.name)?.id === id && sameClient(current, client)) {
              // Tmux has no popup-ID close: external replacement cannot be proven safe.
              try {
                await this.tmux.closePopup(client.name);
              } catch (error) {
                cleanupCauses.push(error);
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
            new TerminalOperationError(cleanupUncertain ? "terminal_busy" : cancellationCode()),
          );
        }
      })();
      return cancellationState.task;
    };
    let directory: string | undefined = undefined;
    const cleanup = async () => {
      if (cleanupUncertain) {
        try {
          const clients = await this.tmux.listClients();
          if (
            popupCompleted ||
            !clients.some((current) => current.name === client.name && current.pid === client.pid)
          ) {
            cleanupUncertain = false;
            const currentLease = this.leases.get(client.name);
            if (currentLease?.id === id) {
              currentLease.quarantined = false;
            }
          }
        } catch (error) {
          cleanupCauses.push(error);
        }
      }
      try {
        if (directory) {
          await rm(directory, { recursive: true, force: true });
          directory = undefined;
        }
      } catch (error) {
        cleanupCauses.push(error);
      }
      if (cleanupUncertain || directory !== undefined) {
        throw new TerminalOperationError(
          cleanupUncertain ? "terminal_busy" : "backend_unavailable",
          presenting,
          {
            cause: new AggregateError(cleanupCauses, "Terminal cleanup incomplete"),
          },
        );
      }
      if (this.leases.get(client.name)?.id === id) {
        this.leases.delete(client.name);
      }
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
      cleanup: async () => cleanup(),
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
          await cancel("client");
        }
      } catch {
        await cancel("client");
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => {
      void checkClient();
    }, this.pollMs);
    timer.unref();
    const finish = async () => {
      try {
        await cleanup();
        completion.resolve();
      } catch (error) {
        completion.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
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
          if (presenting || preparing) {
            throw new TerminalOperationError("terminal_busy");
          }
          preparing = true;
          const launcher = path.join(context.directory, "popup.sh");
          await writeFile(
            launcher,
            `exec /usr/bin/env -- ${Object.entries(env)
              .map(([key, value]) => shellEscape(`${key}=${value}`))
              .join(" ")} /bin/sh -c ${shellEscape(options.command)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
          checkActive();
          const current = await this.resolveClient();
          checkActive();
          if (!sameClient(current, client)) {
            throw new TerminalOperationError("backend_unavailable");
          }
          preparing = false;
          presenting = true;
          popupOpen = true;
          await Promise.race([
            this.tmux
              .displayPopup({
                ...options,
                client: client.name,
                pane: this.dashboardPane,
                command: `/bin/sh ${shellEscape(launcher)}`,
                cwd,
              })
              .then(() => {
                popupCompleted = true;
                if (cleanupUncertain) {
                  cleanupUncertain = false;
                  lease.quarantined = false;
                  if (
                    !active &&
                    directory === undefined &&
                    this.leases.get(client.name)?.id === id
                  ) {
                    this.leases.delete(client.name);
                  }
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
        code = cancellationCode();
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
      await finish();
    }
  }

  private detachKey(client: Client): string {
    return JSON.stringify([this.server, client.name]);
  }

  public async detachHost(owner: TerminalOwner, isCurrent: () => boolean): Promise<void> {
    const client = await this.resolveClient();
    const key = this.detachKey(client);
    if (this.closed || !isCurrent() || this.registry.detaching.has(key)) {
      throw new TerminalOperationError("backend_unavailable");
    }
    this.registry.detaching.add(key);
    try {
      const lease = this.leases.get(client.name);
      if (lease) {
        const sameSessionTask =
          lease.owner.kind === "task" && lease.owner.sessionId === owner.sessionId;
        if (
          lease.manager !== this.manager ||
          (!sameOwner(owner, lease.owner) && !sameSessionTask)
        ) {
          throw new TerminalOperationError("backend_unavailable");
        }
        await settleLease(lease);
      }
      const current = await this.resolveClient();
      if (
        this.closed ||
        !isCurrent() ||
        !sameClient(client, current) ||
        this.leases.has(client.name)
      ) {
        throw new TerminalOperationError("backend_unavailable");
      }
      await this.tmux.detachClient(client.name);
    } catch (error) {
      throw new TerminalOperationError("backend_unavailable", false, { cause: error });
    } finally {
      this.registry.detaching.delete(key);
    }
  }

  public async cancelOwner(owner: TerminalOwner): Promise<void> {
    const results = await Promise.allSettled(
      [...this.leases.values()]
        .filter((lease) => lease.manager === this.manager && sameOwner(owner, lease.owner))
        .map(async (lease) => settleLease(lease)),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Terminal operation cleanup incomplete");
    }
  }

  public async dispose(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.leases.values()]
        .filter((lease) => lease.manager === this.manager)
        .map(async (lease) => settleLease(lease)),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Terminal operation cleanup incomplete");
    }
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
