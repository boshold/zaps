import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutNode, ResolvedConfig } from "#src/config/types.js";
import type { SessionCreateParams } from "#src/daemon/session.js";
import { Session } from "#src/daemon/session.js";
import { getEnv } from "#src/lib/env.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { Rect } from "#src/lib/tmux-layout.js";
import { computeRects } from "#src/lib/tmux-layout.js";
import type { LayoutReflowDeps, PaneMap } from "#src/lib/tmux-reflow.js";
import { LayoutReflow, TmuxFailedError } from "#src/lib/tmux-reflow.js";
import { capturePane, getWindowSize, paneIndexOrder, sendKeys, splitPane } from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const execFileAsync = promisify(execFile);

interface PaneGeom {
  id: string;
  pid: number;
  rect: Rect;
}

function tmuxSocketArgs(): string[] {
  const socket = getEnv("ZAPS_TMUX_SOCKET");
  return socket ? ["-L", socket] : [];
}

/** Read every pane's id, pid, and absolute geometry in spatial (pane_index) order. */
async function listPaneGeoms(target: string): Promise<PaneGeom[]> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxSocketArgs(),
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [indexStr, id, pidStr, leftStr, topStr, widthStr, heightStr] = line.split("\t");
      return {
        index: Number.parseInt(indexStr, 10),
        id,
        pid: Number.parseInt(pidStr, 10),
        rect: {
          x: Number.parseInt(leftStr, 10),
          y: Number.parseInt(topStr, 10),
          width: Number.parseInt(widthStr, 10),
          height: Number.parseInt(heightStr, 10),
        },
      };
    })
    .toSorted((a, b) => a.index - b.index)
    .map(({ id, pid, rect }) => ({ id, pid, rect }));
}

/** Poll until `predicate(value)` is true or `timeoutMs` elapses. */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
  pollMs = 50,
): Promise<T> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- polling */
  let value = await read();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    value = await read();
  }
  /* eslint-enable no-await-in-loop */
  return value;
}

/** Active pane id for `target` (per-session, even with no attached client). */
async function activePane(target: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxSocketArgs(),
    "display-message",
    "-p",
    "-t",
    target,
    "#{pane_id}",
  ]);
  return stdout.trim();
}

/**
 * Stand up a LayoutReflow with the real tmux wrappers (defaults), targeting the
 * Test session. Used by the geometry/focus/rollback scenarios that don't need a
 * Full Session.
 */
function makeReflow(
  layout: LayoutNode,
  paneMap: PaneMap,
  sessionName: string,
  overrides: Partial<LayoutReflowDeps> = {},
): LayoutReflow {
  return new LayoutReflow({
    getLayout: () => layout,
    getPaneMap: () => paneMap,
    getWindowTarget: () => sessionName,
    ...overrides,
  });
}

/**
 * Build a minimal `ResolvedConfig` declaring `services` (each with a trivial
 * `start`). Used to instantiate a Session for the log-flow tests.
 */
function makeConfig(
  services: string[],
  layout: LayoutNode,
  configPath = "/test/.zaps.mts",
): ResolvedConfig {
  return {
    project: {
      name: "p03-t05-test",
      services: Object.fromEntries(services.map((name) => [name, { start: "true" }])),
      layout,
    },
    configPath,
    projectDir: "/test",
    groups: new Map(),
    unavailableServices: new Map(),
  } as ResolvedConfig;
}

/** No-op ServiceManager stub. Session only uses the EventEmitter facet here. */
function makeFakeManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    abortStartAll: vi.fn(),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => []),
    getStatus: vi.fn(),
  }) as unknown as ServiceManager;
}

/**
 * Construct a real Session targeting the test tmux session. `capturePane` is the
 * REAL one (so the LogMonitor reads actual pane output); everything else the
 * Session ctor needs is a no-op stub — these tests don't exercise the manager.
 */
function makeSession(
  tmuxSession: string,
  initialPaneId: string,
  config: ResolvedConfig,
  paneMap: PaneMap,
): Session {
  const params: SessionCreateParams = {
    configPath: config.configPath,
    projectDir: config.projectDir,
    config,
    paneMap,
    tmuxSession,
    originPane: initialPaneId,
    deps: {
      capturePane,
      sendKeys: vi.fn().mockResolvedValue(undefined),
      sendCtrlC: vi.fn().mockResolvedValue(undefined),
      panePid: vi.fn().mockResolvedValue(0),
      detectPorts: vi.fn().mockResolvedValue([]),
      getDescendantPids: vi.fn().mockResolvedValue([]),
      renameWindow: vi.fn().mockResolvedValue(undefined),
      getWindowName: vi.fn().mockResolvedValue("test"),
      getWindowOption: vi.fn().mockResolvedValue(""),
    } as unknown as ServiceManagerDeps,
  };
  return new Session(params, makeFakeManager());
}

describe.skipIf(!hasTmux())("LayoutReflow.insertPane — real tmux", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("inserts a pane at its declared middle slot with exact geometry; sibling pids preserved", async () => {
    // Start with TWO panes spatially: [@tui, web]. The lazy `api` is declared
    // To live BETWEEN them and has no pane yet — insertPane must split off
    // @tui (predecessor) so `api` lands in slot index 2 (DFS middle).
    const web = await splitPane(session.initialPaneId, "h");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 2,
    );
    const before = await listPaneGeoms(session.name);
    const tuiPid = before[0].pid;
    const webPid = before[1].pid;

    const paneMap: PaneMap = { "@tui": session.initialPaneId, web };
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "40%" },
        { pane: "web", size: "30%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.insertPane("api");

    // Three panes; api landed at DFS slot index 1 (middle).
    const after = await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 3,
    );
    const { width, height } = await getWindowSize(session.name);
    const expected = computeRects(layout, width, height);

    expect(paneMap.api).toBeDefined();
    // Exact rects per declared name.
    expect(after[0].rect).toEqual(expected.get("@tui"));
    expect(after[1].rect).toEqual(expected.get("api"));
    expect(after[2].rect).toEqual(expected.get("web"));
    // Sibling pids preserved (only `api` is a new process).
    expect(after[0].pid).toBe(tuiPid);
    expect(after[2].pid).toBe(webPid);
    // The new pane is the middle one; its pid is fresh.
    expect(after[1].pid).not.toBe(tuiPid);
    expect(after[1].pid).not.toBe(webPid);
  });

  it("middle-insert uses ZERO swap-pane calls (adjacency split path)", async () => {
    const web = await splitPane(session.initialPaneId, "h");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 2,
    );
    const paneMap: PaneMap = { "@tui": session.initialPaneId, web };
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "web" }],
    };
    // Spy on the wrapper-level swapPanes — we wire a custom dep that records,
    // Then defers to the real wrapper (which should never be called here).
    const swapSpy = vi.fn();
    const reflow = makeReflow(layout, paneMap, session.name, {
      swapPanes: async (src, dst) => {
        swapSpy(src, dst);
      },
    });

    await reflow.insertPane("api");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 3,
    );

    expect(swapSpy).not.toHaveBeenCalled();
  });

  it("front-insert (declared FIRST) uses split -b and lands in slot index 0", async () => {
    // Start with one pane [@tui]; layout declares `api` BEFORE `@tui`.
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "api" }, { pane: "@tui" }],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.insertPane("api");

    const order = await waitFor(
      async () => paneIndexOrder(session.name),
      (entries) => entries.length === 2,
    );
    // Spatial DFS order: api first, @tui second.
    expect(order[0].id).toBe(paneMap.api);
    expect(order[1].id).toBe(session.initialPaneId);
    // Exact geometry per declared.
    const { width, height } = await getWindowSize(session.name);
    const expected = computeRects(layout, width, height);
    const geoms = await listPaneGeoms(session.name);
    expect(geoms[0].rect).toEqual(expected.get("api"));
    expect(geoms[1].rect).toEqual(expected.get("@tui"));
  });
});

describe.skipIf(!hasTmux())("LayoutReflow.removePane — real tmux", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("kills the pane and re-expands survivors to exact declared widths; pids preserved", async () => {
    // Build 3-pane window [@tui, api, web].
    const api = await splitPane(session.initialPaneId, "h");
    const web = await splitPane(api, "h");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 3,
    );
    const before = await listPaneGeoms(session.name);
    const tuiPid = before.find((p) => p.id === session.initialPaneId)?.pid;
    const webPid = before.find((p) => p.id === web)?.pid;
    expect(tuiPid).toBeDefined();
    expect(webPid).toBeDefined();

    const paneMap: PaneMap = { "@tui": session.initialPaneId, api, web };
    // After remove, declared visible = [@tui, web] at 50/50.
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "api" }, // No longer visible after remove.
        { pane: "web", size: "50%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.removePane("api");

    const after = await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 2,
    );
    expect(paneMap.api).toBeUndefined();
    // Survivor pids unchanged.
    expect(after.find((p) => p.id === session.initialPaneId)?.pid).toBe(tuiPid);
    expect(after.find((p) => p.id === web)?.pid).toBe(webPid);
    // Survivors filled the available width — filterTree collapsed away `api`
    // And computeRects normalized the surviving proportions to 50/50.
    const { width, height } = await getWindowSize(session.name);
    const visibleLayout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "50%" },
        { pane: "web", size: "50%" },
      ],
    };
    const expected = computeRects(visibleLayout, width, height);
    expect(after[0].rect).toEqual(expected.get("@tui"));
    expect(after[1].rect).toEqual(expected.get("web"));
  });
});

describe.skipIf(!hasTmux())("LayoutReflow focus semantics — real tmux", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("an insert without focus:true leaves the previously-active pane active", async () => {
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const reflow = makeReflow(layout, paneMap, session.name);
    const activeBefore = await activePane(session.name);
    expect(activeBefore).toBe(session.initialPaneId);

    await reflow.insertPane("api");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 2,
    );

    const activeAfter = await activePane(session.name);
    expect(activeAfter).toBe(session.initialPaneId);
    // Sanity: the new pane is NOT the active one.
    expect(activeAfter).not.toBe(paneMap.api);
  });

  it("an insert with focus:true moves focus to the new pane", async () => {
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api", focus: true }],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.insertPane("api");
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 2,
    );

    const activeAfter = await activePane(session.name);
    expect(activeAfter).toBe(paneMap.api);
  });
});

describe.skipIf(!hasTmux())("Session.reflow log lifecycle — real tmux", () => {
  let session: TestSession;
  let zapsSession: Session;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("printed line in a lazily-inserted pane reaches its LogBuffer + broadcast", async () => {
    // Lazy `api`: declared but no pane in paneMap at construction.
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const config = makeConfig(["api"], layout);
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    zapsSession = makeSession(session.name, session.initialPaneId, config, paneMap);
    const broadcastSpy = vi.spyOn(zapsSession, "broadcast");

    await zapsSession.reflow.insertPane("api");

    // The pane is now live; allocatePaneLog wired the monitor on its id.
    expect(zapsSession.paneMap.api).toBeDefined();
    const apiPaneId = zapsSession.paneMap.api;
    expect(zapsSession.paneBuffers.has(apiPaneId)).toBe(true);

    // Print a deterministic marker into the pane and wait for the monitor's
    // 500ms tick to capture + diff it.
    const marker = "P03_T05_INSERT_MARKER";
    await sendKeys(apiPaneId, `echo ${marker}`);

    const snap = await waitFor(
      async () => zapsSession.logBuffers.get("api")?.snapshot() ?? [],
      (lines) => lines.some((line) => line.includes(marker)),
      5000,
    );
    expect(snap.some((line) => line.includes(marker))).toBe(true);

    // Broadcast fan-out: an event with service:"api" containing the marker line.
    const apiEvents = broadcastSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event === "log.lines");
    const apiEvent = apiEvents.find(
      (event) =>
        (event.data as { service: string }).service === "api" &&
        (event.data as { lines: string[] }).lines.some((line) => line.includes(marker)),
    );
    expect(apiEvent).toBeDefined();
  });

  it("after remove the monitor key is gone; logBuffers[name] is RETAINED with history", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const config = makeConfig(["api"], layout);
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    zapsSession = makeSession(session.name, session.initialPaneId, config, paneMap);

    await zapsSession.reflow.insertPane("api");
    const apiPaneId = zapsSession.paneMap.api;
    // Plant a history line directly (no need to wait for the monitor here).
    zapsSession.logBuffers.get("api")?.appendLines(["history-from-insert"]);

    await zapsSession.reflow.removePane("api");

    // Pane is gone.
    await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.every((p) => p.id !== apiPaneId),
    );

    // Pane-keyed maps SHRANK; service-keyed buffer + history RETAINED.
    expect(zapsSession.paneBuffers.has(apiPaneId)).toBe(false);
    expect(zapsSession.paneMembers.has(apiPaneId)).toBe(false);
    expect(zapsSession.logBuffers.has("api")).toBe(true);
    expect(zapsSession.logBuffers.get("api")?.snapshot()).toContain("history-from-insert");
    // AttachSnapshot still surfaces the stopped lazy service (Round-7 invariant).
    const snap = zapsSession.attachSnapshot();
    expect(snap.logSnapshots).toHaveProperty("api");
    expect(snap.logSnapshots.api).toContain("history-from-insert");
  });

  it("repeated insert/remove does NOT grow paneBuffers / paneMembers", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const config = makeConfig(["api"], layout);
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    zapsSession = makeSession(session.name, session.initialPaneId, config, paneMap);

    const baselinePaneBufs = zapsSession.paneBuffers.size;
    const baselinePaneMembers = zapsSession.paneMembers.size;

    /* eslint-disable no-await-in-loop -- sequential lifecycle test */
    for (let i = 0; i < 5; i += 1) {
      await zapsSession.reflow.insertPane("api");
      await zapsSession.reflow.removePane("api");
    }
    /* eslint-enable no-await-in-loop */

    expect(zapsSession.paneBuffers.size).toBe(baselinePaneBufs);
    expect(zapsSession.paneMembers.size).toBe(baselinePaneMembers);
    // The retained service buffer is still there.
    expect(zapsSession.logBuffers.has("api")).toBe(true);
  });

  it("a never-started lazy service snapshots [] (Round-7 invariant)", async () => {
    // `web` is declared but never has a pane assigned — boots with a private
    // Buffer (`allocateLogBuffers`'s detached branch), and we never call
    // InsertPane for it.
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "web" }],
    };
    const config = makeConfig(["web"], layout);
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    zapsSession = makeSession(session.name, session.initialPaneId, config, paneMap);

    const snap = zapsSession.attachSnapshot();
    expect(snap.logSnapshots).toHaveProperty("web");
    expect(snap.logSnapshots.web).toEqual([]);
  });
});

describe.skipIf(!hasTmux())("LayoutReflow rollback — real tmux fault injection", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("on selectLayout failure during insert: kills new pane, restores prior geometry, paneMap untouched", async () => {
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };

    const before = await listPaneGeoms(session.name);
    expect(before).toHaveLength(1);
    const tuiPid = before[0].pid;

    // Inject a wrapper that throws on the FIRST selectLayout (productive) but
    // Defers to the real wrapper for the rollback restore.
    const tmux = await import("#src/lib/tmux.js");
    const realSelect = tmux.selectLayout;
    let calls = 0;
    const reflow = makeReflow(layout, paneMap, session.name, {
      selectLayout: async (target, layoutStr) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("forced selectLayout failure (productive)");
        }
        await realSelect(target, layoutStr);
      },
    });

    await expect(reflow.insertPane("api")).rejects.toBeInstanceOf(TmuxFailedError);

    // PaneMap rolled back.
    expect(paneMap.api).toBeUndefined();
    // The new pane was killed; only @tui remains.
    const after = await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) => panes.length === 1,
    );
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(session.initialPaneId);
    expect(after[0].pid).toBe(tuiPid);
    // ProductiveCall + restoreCall.
    expect(calls).toBe(2);
  });

  it("Session-level rollback: paneBuffers cleaned, logBuffers retained (orphan-regression)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }],
    };
    const config = makeConfig(["api"], layout);
    const paneMap: PaneMap = { "@tui": session.initialPaneId };
    const zapsSession = makeSession(session.name, session.initialPaneId, config, paneMap);

    // The Session built its own reflow with real wrappers; here we build a
    // FAULT-INJECTING reflow but reuse the SESSION's hooks so the
    // OnPaneInsertFailed → freePaneLog cleanup actually runs. This is the
    // End-to-end seal on the cross-pane-id buffer-leak fix.
    const tmux = await import("#src/lib/tmux.js");
    const realSelect = tmux.selectLayout;
    let calls = 0;
    let observedPaneId: string | undefined;
    const faultyReflow = new LayoutReflow({
      getLayout: () => layout,
      getPaneMap: () => zapsSession.paneMap,
      getWindowTarget: () => session.name,
      selectLayout: async (target, layoutStr) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("forced selectLayout failure");
        }
        await realSelect(target, layoutStr);
      },
      onPaneInserted: (name, paneId) => {
        observedPaneId = paneId;
        zapsSession.allocatePaneLog(name, paneId);
      },
      onPaneInsertFailed: (name, paneId) => {
        zapsSession.freePaneLog(name, paneId);
      },
      onPaneRemoved: (name, paneId) => {
        zapsSession.freePaneLog(name, paneId);
      },
    });

    await expect(faultyReflow.insertPane("api")).rejects.toBeInstanceOf(TmuxFailedError);
    // The new pane id was observed by allocatePaneLog (so the orphan cleanup
    // Path was exercised, not a no-op).
    expect(observedPaneId).toBeDefined();
    const failedPaneId = observedPaneId ?? "";
    // Pane-keyed entries cleaned up — the cross-pane-id buffer-leak path.
    expect(zapsSession.paneBuffers.has(failedPaneId)).toBe(false);
    expect(zapsSession.paneMembers.has(failedPaneId)).toBe(false);
    // Service-keyed buffer retained (Round-7).
    expect(zapsSession.logBuffers.has("api")).toBe(true);
    // PaneMap rolled back.
    expect(zapsSession.paneMap.api).toBeUndefined();
    // Restore selectLayout was called.
    expect(calls).toBe(2);
  });
});
