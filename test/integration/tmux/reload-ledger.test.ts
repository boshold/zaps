import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import type { ResolvedConfig } from "#src/config/types.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { RuntimeDriver } from "#src/lib/backend/types.js";
import { tmuxFor } from "#src/lib/tmux.js";

const exec = promisify(execFile);

it("cleans failed reload acquisitions before allocating and retains the personal host", async () => {
  const socket = `zaps-reload-${randomUUID()}`;
  const name = "personal";
  const { stdout } = await exec("tmux", [
    "-L",
    socket,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "160",
    "-y",
    "60",
    "-P",
    "-F",
    "#{pane_id}|#{window_id}",
  ]);
  const [originPane, tmuxWindow] = stdout.trim().split("|");
  if (!originPane || !tmuxWindow) {
    throw new Error("Missing owned host identity");
  }
  const tmux = tmuxFor(socket);
  let failSplit = false;
  let failCleanup = false;
  let acquired: string | undefined;
  let splits = 0;
  const splitPane: typeof tmux.splitPane = async (...args) => {
    splits += 1;
    if (failSplit && acquired) {
      throw new Error("injected split failure");
    }
    const pane = await tmux.splitPane(...args);
    if (failSplit) {
      acquired = pane;
    }
    return pane;
  };
  const killPane: typeof tmux.killPane = async (pane) => {
    if (failCleanup && pane === acquired) {
      throw new Error("injected rollback failure");
    }
    await tmux.killPane(pane);
  };
  const runtime: RuntimeDriver = {
    start: vi.fn(),
    stop: vi.fn(),
    getPid: vi.fn(),
    isRunning: vi.fn(),
    readOutput: vi.fn(),
    subscribe: () => () => {
      /* Mock */
    },
  };
  let backend: TmuxSessionBackend | undefined;
  const errors: unknown[] = [];
  try {
    backend = await TmuxSessionBackend.create({
      tmux: { ...tmux, splitPane, killPane },
      runtime,
      host: { tmuxSession: name, tmuxWindow, originPane, tmuxSocket: socket, managedTmux: false },
      services: { original: { start: "true" } },
    });
    const config: ResolvedConfig = {
      project: {
        name: "reload",
        services: { first: { start: "true" }, second: { start: "true" } },
      },
      configPath: "/unused/.zaps.mts",
      projectDir: "/unused",
      groups: new Map(),
      unavailableServices: new Map(),
      lazyPaneByService: new Map(),
    };
    failSplit = true;
    failCleanup = true;
    await expect(backend.reload(config, new Set())).rejects.toThrow();
    if (!acquired) {
      throw new Error("Missing retained pane");
    }
    expect(await tmux.paneExists(acquired)).toBe(true);
    const previousSplits = splits;
    await expect(backend.reload(config, new Set())).rejects.toThrow("cleanup incomplete");
    expect(splits).toBe(previousSplits);
    failCleanup = false;
    failSplit = false;
    await backend.reload(config, new Set());
    expect(await tmux.paneExists(acquired)).toBe(false);
    expect(await backend.health()).toBe("alive");
    await backend.dispose();
    expect(await tmux.paneExists(originPane)).toBe(true);
    expect(await tmux.hasSession(name)).toBe(true);
  } catch (error) {
    errors.push(error);
  }
  try {
    await backend?.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    await tmux.killSession(name);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "Owned tmux test cleanup failed");
  }
});
