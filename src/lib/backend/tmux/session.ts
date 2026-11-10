import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
import type {
  PresentationSnapshot,
  RuntimeDriver,
  SessionBackend,
  TerminalDriver,
} from "#src/lib/backend/types.js";
import { MANAGED_SOCKET } from "#src/lib/managed-tmux.js";
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
  terminal?: TerminalDriver;
  layout?: LayoutNode;
  services: Record<string, ServiceConfig>;
  groups?: Map<string, string[]>;
  skip?: Set<string>;
}

class TmuxSessionBackend implements SessionBackend {
  public readonly id = "tmux";
  public readonly runtime: RuntimeDriver;
  public readonly terminal?: TerminalDriver;
  public readonly capabilities;
  private readonly options: TmuxSessionOptions;
  private paneMap: Record<string, string> = {};
  private focusPane?: string;
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
      getPaneMap: () => this.paneMap,
      getWindowTarget: () => this.options.host.tmuxWindow,
    });
  }

  public static async create(options: TmuxSessionOptions): Promise<TmuxSessionBackend> {
    const backend = new TmuxSessionBackend(options);
    try {
      await backend.buildLayout();
      return backend;
    } catch (error) {
      await backend.dispose().catch(() => {
        /* Best effort */
      });
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
      tmux,
      skip,
      reserveTuiPane: true,
    });
    this.paneMap = result.paneMap;
    this.focusPane = result.focusPane;
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
    const view = this.getPresentation();
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
    const state = this.windowState;
    if (state) {
      await attempt(async () => tmux.renameWindow(host.tmuxWindow, state.title));
      await attempt(async () =>
        tmux.setWindowOption(host.tmuxWindow, "automatic-rename", state.autoRename),
      );
    }
    await (host.managedTmux
      ? attempt(async () => tmux.killSession(host.tmuxSession))
      : Promise.all(
          [...new Set(Object.values(this.paneMap))]
            .filter((pane) => pane !== host.originPane)
            .map(async (pane) => attempt(async () => tmux.killPane(pane))),
        ));
    this.paneMap = {};
    this.focusPane = undefined;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Tmux host disposal incomplete");
    }
  }
}

export { TmuxSessionBackend };
export type { TmuxHost, TmuxSessionOptions };
