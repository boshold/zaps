import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { getEnv } from "#src/lib/env.js";
import { killSession, newSession, splitPane } from "#src/lib/tmux.js";

const execFileAsync = promisify(execFile);

function tmuxSocketArgs(): string[] {
  const socket = getEnv("ZAPS_TMUX_SOCKET");
  return socket ? ["-L", socket] : [];
}

export interface AttachedClient {
  cleanup: () => void;
}

/**
 * Attach a real tmux client to `session` over a pty (via `script`) so
 * `display-popup` has a "current client". Polls `list-clients` until the client
 * registers, then returns a `cleanup` that detaches it. Caller must gate on
 * {@link hasScriptPty}.
 */
export async function attachClient(session: string): Promise<AttachedClient> {
  const sockArgs = tmuxSocketArgs();
  const attachCmd = ["tmux", ...sockArgs, "attach", "-t", session].join(" ");
  const proc: ChildProcess = spawn("script", ["-qec", attachCmd, "/dev/null"], {
    stdio: "ignore",
  });

  const start = Date.now();
  /* eslint-disable no-await-in-loop -- poll until the client attaches */
  while (Date.now() - start < 5000) {
    try {
      const { stdout } = await execFileAsync("tmux", [...sockArgs, "list-clients", "-t", session]);
      if (stdout.trim().length > 0) {
        break;
      }
    } catch {
      /* Session not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /* eslint-enable no-await-in-loop */

  return {
    cleanup() {
      proc.kill("SIGKILL");
    },
  };
}

export interface TestSession {
  name: string;
  initialPaneId: string;
  cleanup: () => Promise<void>;
}

export async function createTestSession(): Promise<TestSession> {
  const name = `zaps-test-${randomUUID().slice(0, 8)}`;
  const initialPaneId = await newSession(name, { x: 220, y: 50 });
  return {
    name,
    initialPaneId,
    async cleanup() {
      try {
        await killSession(name);
      } catch {
        // Session may already be gone
      }
    },
  };
}

export async function buildTestPaneMap(
  initialPaneId: string,
  serviceNames: string[],
): Promise<Record<string, string>> {
  const paneMap: Record<string, string> = { "@tui": initialPaneId };
  for (const name of serviceNames) {
    const paneId = await splitPane(initialPaneId, "v");
    paneMap[name] = paneId;
  }
  return paneMap;
}

/**
 * Socket the integration suite pins via its vitest env — passed explicitly to
 * `session.create` / `Session`, since the daemon no longer reads the env.
 */
export function testTmuxSocket(): string | null {
  return getEnv("ZAPS_TMUX_SOCKET") ?? null;
}
