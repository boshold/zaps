import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "#src/lib/env.js";
import { currentPaneId, currentSession, newWindow } from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const execFileAsync = promisify(execFile);

function tmuxSocketArgs(): string[] {
  const socket = getEnv("ZAPS_TMUX_SOCKET");
  return socket ? ["-L", socket] : [];
}

describe.skipIf(!hasTmux())("tmux launch context", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await session.cleanup();
  });

  it("keeps the launching pane after the current window changes", async () => {
    const otherPane = await newWindow(session.name);
    vi.stubEnv("TMUX_PANE", session.initialPaneId);

    await execFileAsync("tmux", [...tmuxSocketArgs(), "select-window", "-t", otherPane]);

    const originPane = await currentPaneId();
    expect(originPane).toBe(session.initialPaneId);
    expect(await currentSession(originPane)).toBe(session.name);
  });
});
