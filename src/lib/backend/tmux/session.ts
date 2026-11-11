import { computeBootSkip } from "#src/config/loader.js";
import type { LayoutNode, ResolvedConfig, ServiceConfig } from "#src/config/types.js";
import type {
  PresentationDriver,
  PresentationSnapshot,
  RuntimeDriver,
  SessionBackend,
  TerminalDriver,
} from "#src/lib/backend/types.js";
import { MANAGED_SOCKET } from "#src/lib/managed-tmux.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { LayoutReflow } from "#src/lib/tmux-reflow.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

type TmuxHost = Omit<
  Extract<PresentationSnapshot, { kind: "tmux" }>,
  "paneMap" | "focusPane" | "kind"
>;
interface TmuxSessionOptions {
  host: TmuxHost;
  tmux: TmuxHandle;
  runtime: RuntimeDriver;
  disposeRuntime?: () => Promise<void>;
  terminal?: TerminalDriver;
  layout?: LayoutNode;
  services: Record<string, ServiceConfig>;
  groups?: Map<string, string[]>;
  skip?: Set<string>;
}

async function confirmAbsent(failure: unknown, exists: () => Promise<boolean>): Promise<void> {
  const [probe] = await Promise.allSettled([Promise.resolve().then(exists)]);
  if (probe.status === "rejected") {
    throw new AggregateError([failure, probe.reason], "Tmux cleanup verification failed", {
      cause: failure,
    });
  }
  if (probe.value) {
    throw failure;
  }
}

class TmuxSessionBackend implements SessionBackend {
  public readonly id = "tmux";
  public readonly runtime: RuntimeDriver;
  public readonly terminal?: TerminalDriver;
  public readonly capabilities;
  private readonly options: TmuxSessionOptions;
  private paneMap: Record<string, string> = {};
  private readonly acquiredPanes = new Set<string>();
  private focusPane?: string;
  private lastPublished?: string;
  private layout?: LayoutNode;
  private readonly listeners = new Set<(view: PresentationSnapshot) => void>();
  private readonly reflow: LayoutReflow;
  private disposal?: Promise<void>;
  private disposed = false;
  private windowState?: { title: string; autoRename: string };
  private pendingTitle: Promise<void> = Promise.resolve();
  private pendingLayout: Promise<void> = Promise.resolve();

  private constructor(options: TmuxSessionOptions) {
    if (
      options.tmux.getSocket() !== options.host.tmuxSocket ||
      (options.host.managedTmux && options.host.tmuxSocket !== MANAGED_SOCKET)
    ) {
      throw new Error("Managed tmux requires the private zaps socket");
    }
    this.options = { ...options, host: Object.freeze({ ...options.host }) };
    this.runtime = options.runtime;
    this.terminal = options.terminal;
    this.capabilities = Object.freeze({
      panes: true,
      layout: true,
      rawInput: true,
      zoom: Boolean(options.terminal),
      popups: Boolean(options.terminal),
      taskPanes: Boolean(options.terminal),
    });
    this.layout = options.layout;
    this.reflow = new LayoutReflow({
      tmux: options.tmux,
      getLayout: () => this.layout,
      onPaneInserted: () => this.publish(),
      onPaneRemoved: () => this.publish(),
      onPaneInsertFailed: () => this.publish(),
      getPaneMap: () => this.paneMap,
      getWindowTarget: () => this.options.host.tmuxWindow,
    });
  }

  public readonly presentation: PresentationDriver = {
    hasService: (name) => Boolean(this.paneMap[name]),
    reload: async (config) => this.reload(config, computeBootSkip(config)),
    insert: async (name) => this.insertPane(name),
    remove: async (name) => this.removePane(name),
    updateTitle: async (statuses) => this.updateServiceTitle(statuses),
  };

  public async reload(config: ResolvedConfig, skip: Set<string>): Promise<void> {
    await this.mutate(async () => {
      await this.cleanupLayoutPanes();
      this.paneMap = { "@tui": this.options.host.originPane };
      this.layout = config.project.layout;
      this.options.services = config.project.services;
      this.options.groups = config.groups;
      this.options.skip = skip;
      await this.buildLayout();
    });
  }

  private async cleanupLayoutPanes(): Promise<void> {
    const errors: unknown[] = [];
    for (const pane of new Set([...Object.values(this.paneMap), ...this.acquiredPanes])) {
      if (pane === this.options.host.originPane) {
        continue;
      }
      try {
        await this.options.tmux.killPane(pane);
      } catch (error) {
        try {
          await confirmAbsent(error, async () => this.options.tmux.paneExists(pane));
        } catch (cleanupError) {
          errors.push(cleanupError);
          continue;
        }
      }
      this.acquiredPanes.delete(pane);
      for (const [name, target] of Object.entries(this.paneMap)) {
        if (target === pane) {
          Reflect.deleteProperty(this.paneMap, name);
        }
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Tmux layout cleanup incomplete");
    }
  }

  public static async create(
    options: TmuxSessionOptions,
    onAcquire?: (backend: TmuxSessionBackend) => void,
  ): Promise<TmuxSessionBackend> {
    const backend = new TmuxSessionBackend(options);
    try {
      onAcquire?.(backend);
      await backend.buildLayout();
      return backend;
    } catch (error) {
      try {
        await backend.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Tmux construction cleanup incomplete", {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Tmux host disposed");
    }
  }

  private async buildLayout(): Promise<void> {
    const { host, tmux, services, groups } = this.options;
    const skip = new Set(this.options.skip);
    for (const [name, service] of Object.entries(services)) {
      if (service.detached) {
        skip.add(name);
      }
    }
    const result = await createLayout(host.originPane, this.layout, services, groups, {
      tmux: {
        killPane: tmux.killPane,
        splitPane: async (...args) => {
          const pane = await tmux.splitPane(...args);
          this.acquiredPanes.add(pane);
          return pane;
        },
      },
      skip,
      reserveTuiPane: true,
    });
    this.paneMap = result.paneMap;
    this.acquiredPanes.clear();
    this.focusPane = result.focusPane;
    await tmux.resyncPaneSizes(result.paneMap["@tui"] ?? result.focusPane);
    await tmux.selectPane(result.focusPane);
    this.publish();
  }

  public async reconcileLayout(layout: LayoutNode): Promise<void> {
    await this.mutate(async () => this.applyLayout(layout));
  }

  private async applyLayout(layout: LayoutNode): Promise<void> {
    const previous = this.layout;
    this.layout = layout;
    try {
      await this.reflow.applyGeometry(new Set(Object.keys(this.paneMap)));
    } catch (error) {
      this.layout = previous;
      throw error;
    }
    this.publish();
  }

  public async insertPane(name: string): Promise<void> {
    await this.mutate(async () => this.insert(name));
  }

  private async insert(name: string): Promise<void> {
    if (!this.options.services[name] || this.options.services[name].detached) {
      throw new Error(`No terminal service: ${name}`);
    }
    if (!this.layout) {
      if (this.paneMap[name]) {
        throw new Error(`Pane already exists: ${name}`);
      }
      this.paneMap[name] = await this.options.tmux.splitPane(this.options.host.originPane, "v", {
        detached: true,
      });
    } else {
      await this.reflow.insertPane(name);
      const focus = await this.options.tmux.displayMessage(
        this.options.host.tmuxWindow,
        "#{pane_id}",
      );
      if (Object.values(this.paneMap).includes(focus)) {
        this.focusPane = focus;
      }
    }
    this.publish();
  }

  public async removePane(name: string): Promise<void> {
    await this.mutate(async () => this.remove(name));
  }

  private async remove(name: string): Promise<void> {
    if (name === "@tui") {
      throw new Error("Cannot remove dashboard pane");
    }
    const pane = this.paneMap[name];
    if (pane && Object.values(this.paneMap).filter((id) => id === pane).length > 1) {
      throw new Error("Cannot remove a shared group pane");
    }
    if (!this.layout) {
      if (pane) {
        await this.options.tmux.killPane(pane);
        const { [name]: removed, ...remaining } = this.paneMap;
        void removed;
        this.paneMap = remaining;
      }
    } else {
      await this.reflow.removePane(name);
    }
    if (this.focusPane && !Object.values(this.paneMap).includes(this.focusPane)) {
      this.focusPane = this.paneMap["@tui"];
    }
    this.publish();
  }

  private async mutate(action: () => Promise<void>): Promise<void> {
    this.assertActive();
    const previous = this.pendingLayout;
    this.pendingLayout = (async () => {
      await previous.catch(() => {
        /* Prior caller owns failure */
      });
      const paneMap = { ...this.paneMap };
      const { focusPane } = this;
      try {
        await action();
      } catch (error) {
        if (this.focusPane && !Object.values(this.paneMap).includes(this.focusPane)) {
          this.focusPane = this.paneMap["@tui"];
        }
        if (
          focusPane !== this.focusPane ||
          Object.keys(paneMap).length !== Object.keys(this.paneMap).length ||
          Object.entries(paneMap).some(([name, pane]) => this.paneMap[name] !== pane)
        ) {
          this.publish();
        }
        throw error;
      }
    })();
    await this.pendingLayout;
  }

  public paneFor(name: string): string {
    this.assertActive();
    const pane = this.paneMap[name];
    if (!pane) {
      throw new Error(`No pane for service: ${name}`);
    }
    return pane;
  }

  public getPresentation(): PresentationSnapshot {
    return Object.freeze({
      kind: "tmux",
      ...this.options.host,
      paneMap: Object.freeze({ ...this.paneMap }),
      ...(this.focusPane ? { focusPane: this.focusPane } : {}),
    });
  }

  public subscribePresentation(listener: (view: PresentationSnapshot) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    if (this.focusPane && !Object.values(this.paneMap).includes(this.focusPane)) {
      this.focusPane = this.paneMap["@tui"];
    }
    const view = this.getPresentation();
    const serialized = JSON.stringify(view);
    if (serialized === this.lastPublished) {
      return;
    }
    this.lastPublished = serialized;
    for (const listener of this.listeners) {
      listener(view);
    }
  }

  public async health(): Promise<"alive" | "lost"> {
    if (this.disposed || this.options.tmux.getSocket() !== this.options.host.tmuxSocket) {
      return "lost";
    }
    try {
      const { tmux, host } = this.options;
      if (!(await tmux.hasSession(host.tmuxSession)) || !(await tmux.paneExists(host.originPane))) {
        return "lost";
      }
      return (await tmux.displayMessage(host.originPane, "#{pane_dead}")) === "0"
        ? "alive"
        : "lost";
    } catch {
      return "lost";
    }
  }

  public async restoreWindowTitles(): Promise<void> {
    const previous = this.pendingTitle;
    this.pendingTitle = (async () => {
      await previous.catch(() => {
        /* Prior caller owns failure. */
      });
      const state = this.windowState;
      if (!state) {
        return;
      }
      const { tmux, host } = this.options;
      await tmux.renameWindow(host.tmuxWindow, state.title);
      await tmux.setWindowOption(host.tmuxWindow, "automatic-rename", state.autoRename);
    })();
    await this.pendingTitle;
  }

  public async updateServiceTitle(statuses: ServiceStatus[]): Promise<void> {
    if (statuses.every((status) => status.state === "stopped" || status.state === "unavailable")) {
      await this.restoreWindowTitles();
      return;
    }
    const counts: Record<string, number> = {};
    for (const status of statuses) {
      if (status.state === "unavailable") {
        continue;
      }
      counts[status.state] = (counts[status.state] ?? 0) + 1;
    }

    const symbols: [string, string][] = [
      ["error", "✖"],
      ["starting", "◐"],
      ["restarting", "◐"],
      ["stopping", "◐"],
      ["ready", "●"],
      ["stopped", "○"],
    ];

    const parts: string[] = [];
    for (const [state, symbol] of symbols) {
      const count = counts[state] ?? 0;
      if (count > 0) {
        parts.push(`${symbol}${count}`);
      }
    }

    const title = parts.length > 0 ? `zaps (${parts.join(" ")})` : "zaps";
    await this.updateWindowTitle(title);
  }

  public async activateWindowTitles(): Promise<void> {
    this.assertActive();
    const previous = this.pendingTitle;
    this.pendingTitle = (async () => {
      await previous.catch(() => {
        /* Prior caller owns failure */
      });
      if (!this.windowState) {
        const { tmux, host } = this.options;
        const [title, autoRename] = await Promise.all([
          tmux.getWindowName(host.tmuxWindow),
          tmux.getWindowOption(host.tmuxWindow, "automatic-rename"),
        ]);
        this.windowState = { title, autoRename };
      }
    })();
    await this.pendingTitle;
  }

  public async updateWindowTitle(title: string): Promise<void> {
    this.assertActive();
    if (!this.windowState) {
      throw new Error("Window title ownership not activated");
    }
    const previous = this.pendingTitle;
    this.pendingTitle = (async () => {
      await previous.catch(() => {
        /* Best effort */
      });
      await this.options.tmux.renameWindow(this.options.host.tmuxWindow, title);
    })();
    await this.pendingTitle;
  }

  // oxlint-disable-next-line promise-function-async
  public dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.disposeHost();
    return this.disposal;
  }

  public async retryCleanup(): Promise<void> {
    this.disposed = true;
    await this.disposeHost();
  }

  private async disposeHost(): Promise<void> {
    const { tmux, host } = this.options;
    this.listeners.clear();
    await this.pendingLayout.catch(() => {
      /* Caller owns failure */
    });
    await this.pendingTitle.catch(() => {
      /* Best effort */
    });
    if (host.managedTmux && tmux.getSocket() !== MANAGED_SOCKET) {
      throw new Error("Managed tmux socket changed");
    }
    const errors: unknown[] = [];
    async function attempt(action: () => Promise<void>): Promise<void> {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.options.disposeRuntime) {
      await attempt(this.options.disposeRuntime);
    }
    const state = this.windowState;
    if (state) {
      const restore = async (action: () => Promise<void>): Promise<void> => {
        await attempt(async () => {
          try {
            await action();
          } catch (error) {
            await confirmAbsent(error, async () => tmux.windowExists(host.tmuxWindow));
          }
        });
      };
      await restore(async () => tmux.renameWindow(host.tmuxWindow, state.title));
      await restore(async () =>
        tmux.setWindowOption(host.tmuxWindow, "automatic-rename", state.autoRename),
      );
    }
    await (host.managedTmux
      ? attempt(async () => {
          try {
            await tmux.killSession(host.tmuxSession);
          } catch (error) {
            await confirmAbsent(error, async () => tmux.hasSession(host.tmuxSession));
          }
        })
      : Promise.all(
          [...new Set([...Object.values(this.paneMap), ...this.acquiredPanes])]
            .filter((pane) => pane !== host.originPane)
            .map(async (pane) =>
              attempt(async () => {
                try {
                  await tmux.killPane(pane);
                } catch (error) {
                  await confirmAbsent(error, async () => tmux.paneExists(pane));
                }
                this.acquiredPanes.delete(pane);
                for (const [name, target] of Object.entries(this.paneMap)) {
                  if (target === pane) {
                    Reflect.deleteProperty(this.paneMap, name);
                  }
                }
              }),
            ),
        ));
    if (errors.length > 0) {
      throw new AggregateError(errors, "Tmux host disposal incomplete");
    }
    this.paneMap = {};
    this.acquiredPanes.clear();
    this.focusPane = undefined;
  }
}

export { TmuxSessionBackend };
export type { TmuxHost, TmuxSessionOptions };
