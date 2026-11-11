import type { DisplayPopupOptions, TmuxHandle } from "#src/lib/tmux.js";

interface PopupTarget {
  readonly client: string;
  readonly pane: string;
}

class TmuxTerminalPrimitives {
  private readonly tmux: TmuxHandle;

  public constructor(tmux: TmuxHandle) {
    this.tmux = tmux;
  }

  public async popup(
    target: PopupTarget,
    options: Omit<DisplayPopupOptions, "client" | "pane">,
  ): Promise<void> {
    if (!target.client || !target.pane) {
      throw new Error("Popup requires a resolved tmux client");
    }
    await this.tmux.displayPopup({ ...options, client: target.client, pane: target.pane });
  }

  public async capture(pane: string, lines = 100): Promise<string> {
    return this.tmux.capturePane(pane, lines);
  }

  public async focus(pane: string): Promise<void> {
    await this.tmux.selectPane(pane);
  }

  public async zoom(pane: string): Promise<void> {
    await this.tmux.zoomPane(pane);
  }
}

export { TmuxTerminalPrimitives };
export type { PopupTarget };
