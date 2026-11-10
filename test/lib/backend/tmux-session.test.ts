import { describe, expect, it, vi } from "vitest";

import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import { TmuxTerminalPrimitives } from "#src/lib/backend/tmux/terminal.js";
import type { RuntimeDriver } from "#src/lib/backend/types.js";
import { tmuxFor } from "#src/lib/tmux.js";

function fixture(managed = false) {
  const tmux = {
    ...tmuxFor(managed ? "zaps" : null),
    hasSession: vi.fn(async () => true),
    paneExists: vi.fn(async () => true),
    displayMessage: vi.fn(async () => "0"),
    splitPane: vi.fn(async () => "%2"),
    killPane: vi.fn(async () => {
      /* Mock */
    }),
    killSession: vi.fn(async () => {
      /* Mock */
    }),
    getWindowName: vi.fn(async () => "personal"),
    getWindowOption: vi.fn(async () => "on"),
    setWindowOption: vi.fn(async () => {
      /* Mock */
    }),
    renameWindow: vi.fn(async () => {
      /* Mock */
    }),
    windowLayout: vi.fn(async () => "previous"),
    getWindowSize: vi.fn(async () => ({ width: 80, height: 24 })),
    paneIndexOrder: vi.fn(async () => [
      { index: 0, id: "%1" },
      { index: 1, id: "%2" },
    ]),
    selectLayout: vi.fn(async () => {
      /* Mock */
    }),
    selectPane: vi.fn(async () => {
      /* Mock */
    }),
    displayPopup: vi.fn(async () => {
      /* Mock */
    }),
    capturePane: vi.fn(async () => "output"),
  };
  const runtime: RuntimeDriver = {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(),
    getPid: vi.fn(),
    readOutput: vi.fn(),
    subscribe: () => () => {
      /* Mock */
    },
  };
  return {
    tmux,
    runtime,
    host: {
      tmuxSession: "owned",
      tmuxWindow: "@1",
      originPane: "%1",
      tmuxSocket: managed ? "zaps" : null,
      managedTmux: managed,
    },
    services: { web: { start: "web" }, worker: { start: "worker", detached: true } },
  };
}

describe("tmux session backend", () => {
  it("projects real panes and authoritative host health", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create(options);
    expect(backend.getPresentation()).toMatchObject({
      paneMap: { "@tui": "%1", web: "%2" },
      focusPane: "%1",
    });
    expect(backend.capabilities.popups).toBe(false);
    expect(await backend.health()).toBe("alive");
    options.tmux.displayMessage.mockResolvedValue("1");
    expect(await backend.health()).toBe("lost");
    options.tmux.displayMessage.mockRejectedValue(new Error("gone"));
    expect(await backend.health()).toBe("lost");
    await backend.dispose();
    expect(await backend.health()).toBe("lost");
    expect(options.tmux.killSession).not.toHaveBeenCalled();
    expect(options.tmux.killPane).toHaveBeenCalledExactlyOnceWith("%2");
  });

  it("kills managed hosts once, requires private socket", async () => {
    const options = fixture(true);
    const backend = await TmuxSessionBackend.create(options);
    await Promise.all([backend.dispose(), backend.dispose()]);
    expect(options.tmux.killSession).toHaveBeenCalledExactlyOnceWith("owned");
    await expect(
      TmuxSessionBackend.create({ ...options, host: { ...options.host, tmuxSocket: null } }),
    ).rejects.toThrow("private");
  });

  it("cleans partial layout construction without killing personal host", async () => {
    const options = fixture();
    options.tmux.splitPane
      .mockResolvedValueOnce("%2")
      .mockRejectedValueOnce(new Error("split failed"));
    await expect(
      TmuxSessionBackend.create({
        ...options,
        services: { one: { start: "one" }, two: { start: "two" } },
      }),
    ).rejects.toThrow("split failed");
    expect(options.tmux.killPane).toHaveBeenCalledWith("%2");
    expect(options.tmux.killSession).not.toHaveBeenCalled();
  });

  it("publishes lazy pane changes, preserves snapshots and applies focus", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create({
      ...options,
      layout: { direction: "columns", children: [{ pane: "@tui" }, { pane: "web", focus: true }] },
      skip: new Set(["web"]),
    });
    const before = backend.getPresentation();
    const changed = vi.fn();
    const unsubscribe = backend.subscribePresentation(changed);
    await backend.insertPane("web");
    expect(options.tmux.selectPane).toHaveBeenCalledWith("%2");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(before).toMatchObject({ paneMap: { "@tui": "%1" } });
    options.tmux.paneIndexOrder.mockResolvedValue([{ index: 0, id: "%1" }]);
    await backend.removePane("web");
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(backend.insertPane("worker")).rejects.toThrow("terminal service");
    unsubscribe();
    await backend.dispose();
  });

  it("takes title ownership explicitly and restores exact options", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create(options);
    expect(options.tmux.getWindowName).not.toHaveBeenCalled();
    await expect(backend.updateWindowTitle("zaps")).rejects.toThrow("not activated");
    await backend.activateWindowTitles();
    await backend.updateWindowTitle("zaps");
    await backend.dispose();
    expect(options.tmux.renameWindow).toHaveBeenLastCalledWith("@1", "personal");
    expect(options.tmux.setWindowOption).toHaveBeenCalledWith("@1", "automatic-rename", "on");
  });

  it("waits for in-flight lazy construction before disposal", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create({ ...options, skip: new Set(["web"]) });
    let resolveSplit: ((pane: string) => void) | undefined;
    const split = new Promise<string>((resolve) => {
      resolveSplit = resolve;
    });
    options.tmux.splitPane.mockReturnValue(split);
    const insertion = backend.insertPane("web");
    const disposal = backend.dispose();
    resolveSplit?.("%9");
    await insertion;
    await disposal;
    expect(options.tmux.killPane).toHaveBeenCalledWith("%9");
    expect(options.tmux.killPane).not.toHaveBeenCalledWith("%1");
    expect(() => backend.paneFor("web")).toThrow("disposed");
  });

  it("uses explicit client and pane targets", async () => {
    const { tmux } = fixture(true);
    const terminal = new TmuxTerminalPrimitives(tmux);
    await terminal.popup({ client: "/dev/pts/8" }, { command: "picker" });
    expect(tmux.displayPopup).toHaveBeenCalledWith({ command: "picker", client: "/dev/pts/8" });
    expect(await terminal.capture("%4")).toBe("output");
    expect(tmux.capturePane).toHaveBeenCalledWith("%4", 100);
  });
});
