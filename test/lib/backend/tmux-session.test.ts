import { describe, expect, it, vi } from "vitest";

import type { ResolvedConfig } from "#src/config/types.js";
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
    killPane: vi.fn(async (_pane: string) => {
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

  it("publishes surviving map changes when removal geometry fails", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create({
      ...options,
      layout: { direction: "columns", children: [{ pane: "@tui" }, { pane: "web", focus: true }] },
    });
    const changed = vi.fn();
    backend.subscribePresentation(changed);
    options.tmux.paneIndexOrder.mockResolvedValue([{ index: 0, id: "%1" }]);
    options.tmux.selectLayout.mockRejectedValue(new Error("geometry failed"));
    await expect(backend.removePane("web")).rejects.toThrow("geometry failed");
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        paneMap: { "@tui": "%1" },
        focusPane: "%1",
      }),
    );
    expect(backend.getPresentation()).toMatchObject({ paneMap: { "@tui": "%1" }, focusPane: "%1" });
    await backend.dispose();
  });

  it("publishes inserted pane when the subsequent focus query fails", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create({
      ...options,
      layout: { direction: "columns", children: [{ pane: "@tui" }, { pane: "web", focus: true }] },
      skip: new Set(["web"]),
    });
    const changed = vi.fn();
    backend.subscribePresentation(changed);
    options.tmux.displayMessage.mockRejectedValue(new Error("focus query failed"));
    await expect(backend.insertPane("web")).rejects.toThrow("focus query failed");
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        paneMap: { "@tui": "%1", web: "%2" },
      }),
    );
    await backend.dispose();
  });

  it("attempts every restoration and pane cleanup and aggregates failures", async () => {
    const options = fixture();
    options.tmux.splitPane.mockResolvedValueOnce("%2").mockResolvedValueOnce("%3");
    const backend = await TmuxSessionBackend.create({
      ...options,
      services: { web: { start: "web" }, api: { start: "api" } },
    });
    await backend.activateWindowTitles();
    const titleError = new Error("title restore failed");
    const optionError = new Error("option restore failed");
    const paneError = new Error("pane cleanup failed");
    options.tmux.renameWindow.mockRejectedValue(titleError);
    options.tmux.setWindowOption.mockRejectedValue(optionError);
    options.tmux.killPane.mockRejectedValueOnce(paneError);
    const disposal = backend.dispose();
    await expect(disposal).rejects.toMatchObject({ errors: [titleError, optionError, paneError] });
    expect(options.tmux.setWindowOption).toHaveBeenCalledExactlyOnceWith(
      "@1",
      "automatic-rename",
      "on",
    );
    expect(options.tmux.killPane).toHaveBeenCalledWith("%2");
    expect(options.tmux.killPane).toHaveBeenCalledWith("%3");
    expect(options.tmux.killSession).not.toHaveBeenCalled();
    expect(backend.dispose()).toBe(disposal);
  });

  it("hands off partial-layout ownership before factory rejection and verifies retry cleanup", async () => {
    const options = fixture();
    const splitFailure = new Error("split failed");
    const cleanupFailure = new Error("owned pane survived");
    options.tmux.splitPane.mockResolvedValueOnce("%2").mockRejectedValueOnce(splitFailure);
    options.tmux.killPane.mockRejectedValue(cleanupFailure);
    const owner: { current: TmuxSessionBackend | null } = { current: null };
    await expect(
      TmuxSessionBackend.create(
        {
          ...options,
          services: { first: { start: "true" }, second: { start: "true" } },
        },
        (backend) => {
          owner.current = backend;
        },
      ),
    ).rejects.toThrow("Tmux construction cleanup incomplete");
    const backend = owner.current;
    if (!backend) {
      throw new Error("Missing backend cleanup owner");
    }
    await expect(backend.retryCleanup()).rejects.toMatchObject({ errors: [cleanupFailure] });
    options.tmux.killPane.mockResolvedValue(undefined);
    await expect(backend.retryCleanup()).resolves.toBeUndefined();
    expect(options.tmux.killPane).toHaveBeenCalledWith("%2");
    expect(options.tmux.killPane).not.toHaveBeenCalledWith("%1");
    expect(options.tmux.killSession).not.toHaveBeenCalled();
    const calls = options.tmux.killPane.mock.calls.length;
    await backend.retryCleanup();
    expect(options.tmux.killPane).toHaveBeenCalledTimes(calls);
  });

  it("retains ownership and both errors when cleanup verification is unavailable", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create(options);
    const killFailure = new Error("pane kill failed");
    const probeFailure = new Error("pane ownership unknown");
    options.tmux.killPane.mockRejectedValue(killFailure);
    options.tmux.paneExists.mockRejectedValueOnce(probeFailure);
    await expect(backend.dispose()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ cause: killFailure, errors: [killFailure, probeFailure] }),
      ],
    });
    await expect(backend.retryCleanup()).rejects.toMatchObject({ errors: [killFailure] });
    options.tmux.killPane.mockResolvedValue(undefined);
    await backend.retryCleanup();
    expect(options.tmux.killPane).toHaveBeenCalledTimes(3);
    expect(options.tmux.killPane).not.toHaveBeenCalledWith("%1");
  });

  it("retains failed reload acquisitions until cleanup succeeds before new splits", async () => {
    const options = fixture();
    const backend = await TmuxSessionBackend.create(options);
    const config: ResolvedConfig = {
      project: {
        name: "reload",
        services: { first: { start: "true" }, second: { start: "true" } },
      },
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      groups: new Map(),
      unavailableServices: new Map(),
      lazyPaneByService: new Map(),
    };
    options.tmux.splitPane
      .mockResolvedValueOnce("%3")
      .mockRejectedValueOnce(new Error("split failed"));
    options.tmux.killPane.mockImplementation(async (pane) => {
      if (pane === "%3") {
        throw new Error("partial pane survived");
      }
    });
    await expect(backend.reload(config, new Set())).rejects.toThrow();
    const splits = options.tmux.splitPane.mock.calls.length;
    options.tmux.paneExists.mockRejectedValueOnce(new Error("probe unavailable"));
    await expect(backend.reload(config, new Set())).rejects.toThrow("cleanup incomplete");
    expect(options.tmux.splitPane).toHaveBeenCalledTimes(splits);
    await expect(backend.reload(config, new Set())).rejects.toThrow("cleanup incomplete");
    expect(options.tmux.splitPane).toHaveBeenCalledTimes(splits);
    options.tmux.killPane.mockResolvedValue(undefined);
    options.tmux.splitPane.mockResolvedValueOnce("%4").mockResolvedValueOnce("%5");
    await backend.reload(config, new Set());
    expect(backend.getPresentation()).toMatchObject({ paneMap: { first: "%4", second: "%5" } });
    expect(await backend.health()).toBe("alive");
    expect(options.tmux.killPane).toHaveBeenCalledWith("%3");
    expect(options.tmux.killPane).not.toHaveBeenCalledWith("%1");
    expect(options.tmux.killSession).not.toHaveBeenCalled();
    await backend.dispose();
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
    await terminal.popup({ client: "/dev/pts/8", pane: "%1" }, { command: "picker" });
    expect(tmux.displayPopup).toHaveBeenCalledWith({
      command: "picker",
      client: "/dev/pts/8",
      pane: "%1",
    });
    expect(await terminal.capture("%4")).toBe("output");
    expect(tmux.capturePane).toHaveBeenCalledWith("%4", 100);
  });
});
