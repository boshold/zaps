import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionCreateParams } from "#src/daemon/session.js";
import { Session } from "#src/daemon/session.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import { sendKeys, splitPane } from "#src/lib/tmux.js";

import { makeConfig } from "../helpers/config.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

/**
 * A combined group puts every member service on one shared tmux pane. This
 * Exercises the per-pane LogBuffer + per-member fan-out (D2) end-to-end against
 * Real tmux capture, without requiring docker: the members share a pane, lines
 * Printed to it must surface for EVERY member — including the non-first one —
 * Via both the shared buffer and a `log.lines` event per member name.
 */
function fakeManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: async () => undefined,
    stopAll: async () => undefined,
    abortStartAll: () => undefined,
    getAllStatuses: () => [],
    removeAllListeners: () => emitter,
  }) as unknown as ServiceManager;
}

describe.skipIf(!hasTmux())("combined-pane log fan-out (D2)", () => {
  let tmux: TestSession;
  let session: Session | undefined;

  afterEach(async () => {
    if (session) {
      await session.destroy().catch(() => {
        /* Best-effort */
      });
      session = undefined;
    }
    if (tmux) {
      await tmux.cleanup();
    }
  });

  it("surfaces shared-pane output for every member, never the group name", async () => {
    tmux = await createTestSession();
    const sharedPane = await splitPane(tmux.initialPaneId, "v");

    // Alpha and beta are one combined group sharing `sharedPane`.
    const paneMap: Record<string, string> = {
      "@tui": tmux.initialPaneId,
      alpha: sharedPane,
      beta: sharedPane,
    };
    const config = makeConfig({
      alpha: {
        start: "true",
        _combined: { group: "combo", allServices: ["alpha", "beta"], isOwner: true },
      },
      beta: {
        start: "true",
        dependsOn: ["alpha"],
        _combined: { group: "combo", allServices: ["alpha", "beta"], isOwner: false },
      },
    });

    const params: SessionCreateParams = {
      configPath: "/test/.zaps.mts",
      projectDir: "/test",
      config,
      paneMap,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
      managedTmux: false,
      deps: tmuxDeps as unknown as SessionCreateParams["deps"],
    };
    session = new Session(params, fakeManager());

    // Both members must resolve to one shared buffer; the group never owns one.
    expect(session.logBuffers.get("alpha")).toBe(session.logBuffers.get("beta"));
    expect(session.logBuffers.has("combo")).toBe(false);

    // Collect broadcast log.lines events through a fake subscriber socket.
    const events: DaemonEvent[] = [];
    const fakeSocket = {
      destroyed: false,
      write: (line: string) => {
        events.push(JSON.parse(line.trim()) as DaemonEvent);
        return true;
      },
    };
    session.subscribers.add(fakeSocket as never);

    await session.startAll();

    const marker = `LOG_${randomUUID().slice(0, 8)}`;
    await sendKeys(sharedPane, `echo ${marker}`);

    // Poll the NON-FIRST member's buffer until the shared output appears.
    const deadline = Date.now() + 8000;
    /* eslint-disable no-await-in-loop -- polling for real tmux capture */
    while (Date.now() < deadline) {
      const betaLines = session.logBuffers.get("beta")?.snapshot() ?? [];
      if (betaLines.some((l) => l.includes(marker))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    /* eslint-enable no-await-in-loop */

    const betaSnapshot = session.logBuffers.get("beta")?.snapshot() ?? [];
    expect(betaSnapshot.some((l) => l.includes(marker))).toBe(true);

    // The same lines fan out to both member names — and never the group name.
    const logServices = new Set(
      events
        .filter((e) => e.event === "log.lines")
        .map((e) => (e.data as { service: string }).service),
    );
    expect(logServices.has("alpha")).toBe(true);
    expect(logServices.has("beta")).toBe(true);
    expect(logServices.has("combo")).toBe(false);
  });
});
