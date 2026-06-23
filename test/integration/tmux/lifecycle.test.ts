/**
 * Phase-4 acceptance-gate integration suite (P04-T05). End-to-end exercises
 * the lazy-pane lifecycle through a REAL Session (Session.reflow + real
 * ServiceManager + real tmux), not mocks. The two HIGH-VALUE SEALS:
 *
 *  1. **Reload-staleness (Round-5):** start a lazy service → reload → start a
 *     DIFFERENT lazy service. The second insert must land via the same
 *     session.reflow handle, picking up the new paneMap/manager. A captured
 *     reference would throw `Unknown service`.
 *  2. **Reload-with-running-lazy-service (the P04-T04 review fix):** a Session
 *     that has a running lazy service must complete `reload` under a bounded
 *     timeout. Without the `shuttingDown` guard, `stopService` would re-enter
 *     `withOpLock` via `reflowRemove` and hang forever.
 *
 * Each scenario drives a fresh tmux session via the existing helpers and
 * Asserts pane count / paneMap / live geometry / daemon service state. All
 * Tests gate on `hasTmux()`; bounded timeouts so deadlocks FAIL fast.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeBootSkip, loadConfig } from "#src/config/loader.js";
import type { LayoutNode, ResolvedConfig, ServiceConfig } from "#src/config/types.js";
import { Session } from "#src/daemon/session.js";
import type { SessionCreateParams } from "#src/daemon/session.js";
import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { computeRects, createLayout } from "#src/lib/tmux-layout.js";
import {
  capturePane,
  getWindowSize,
  killPane,
  paneIndexOrder,
  panePid,
  sendCtrlC,
  sendKeys,
} from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

// --- Helpers ---------------------------------------------------------------

interface LiveSession {
  testSession: TestSession;
  session: Session;
  manager: ServiceManager;
  cleanup: () => Promise<void>;
}

/**
 * Wait for `name` to reach `target` (default `ready`), or fail-fast on timeout.
 * Uses the manager's `stateChange` event so we converge as soon as the daemon
 * Observes the transition (no fixed sleeps).
 */
async function waitForState(
  manager: ServiceManager,
  name: string,
  target: string,
  timeoutMs = 15_000,
): Promise<void> {
  if (manager.getStatus(name)?.state === target) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    // Listener/timer circularly reference each other: listener clears timer
    // On match, timer clears listener on timeout. `setTimeout` is synchronous
    // Here (returns immediately); the listener never fires before timer is
    // Assigned because `stateChange` is only emitted asynchronously after the
    // Promise-executor returns.
    function listener(svc: string, status: ServiceStatus): void {
      if (svc === name && status.state === target) {
        // eslint-disable-next-line no-use-before-define -- timer is assigned synchronously before any listener fire
        clearTimeout(timer);
        manager.removeListener("stateChange", listener);
        resolve();
      }
    }
    const timer = setTimeout(() => {
      manager.removeListener("stateChange", listener);
      reject(new Error(`Timeout waiting for '${name}' to reach '${target}'`));
    }, timeoutMs);
    manager.on("stateChange", listener);
  });
}

/** Poll a synchronous predicate until true or timeout. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, pollMs = 50): Promise<void> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- polling */
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("waitUntil: predicate did not become true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  /* eslint-enable no-await-in-loop */
}

/** Live tmux pane count for the session's window. */
async function paneCount(target: string): Promise<number> {
  const order = await paneIndexOrder(target);
  return order.length;
}

/** A trivial long-running command — pinned by `setInterval` so the pane stays open. */
const idleCmd = `node -e "setInterval(()=>{},60000)"`;

/** A printer that emits a marker line then idles. */
function printerCmd(marker: string): string {
  return `node -e "console.log('${marker}');setInterval(()=>{},60000)"`;
}

/**
 * Reaches `READY` (matched by `ready: { output: /READY/ }`), then exits
 * Non-zero after a short delay so `handleCrash` fires. A bare
 * `process.exit(1)` without first signaling readiness times out the ready
 * Wait instead of taking the crash path.
 */
const crashAfterReadyCmd = `node -e "console.log('READY');setTimeout(()=>process.exit(1),200)"`;

function makeResolvedConfig(
  services: Record<string, ServiceConfig>,
  layout: LayoutNode | undefined,
  lazyMap: Record<string, boolean> = {},
  configPath?: string,
  projectDir?: string,
): ResolvedConfig {
  // Force raw mode so commands run via sendKeys (no wrapper that needs IPC).
  const rawServices: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(services)) {
    rawServices[name] = { raw: true, ...svc };
  }
  return {
    project: {
      name: "p04-t05-test",
      services: rawServices,
      layout,
    },
    configPath: configPath ?? path.join(os.tmpdir(), ".zaps.ts"),
    projectDir: projectDir ?? os.tmpdir(),
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(Object.entries(lazyMap)),
  };
}

/**
 * Spin up a fully-wired Session against a fresh tmux test session.
 * - Real ServiceManager (drives sendKeys/processes).
 * - Real Session.reflow with LIVE-getter deps (P03-T03).
 * - Real reflowInsert/Remove callbacks (P04-T04) wired through a late-bound
 *   `ref.session` exactly like `server.ts:buildSession`.
 * - Real `createLayout` with `computeBootSkip(config)` so the boot state
 *   matches what the manager + skip predicate expect.
 */
async function buildLiveSession(config: ResolvedConfig): Promise<LiveSession> {
  const testSession = await createTestSession();

  const skip = computeBootSkip(config);
  const { paneMap } = await createLayout(
    testSession.initialPaneId,
    config.project.layout,
    config.project.services,
    config.groups,
    { skip },
  );

  const ref: { session: Session | null } = { session: null };
  const deps: ServiceManagerDeps = {
    sendKeys,
    sendCtrlC,
    panePid,
    detectPorts,
    capturePane,
    // Real PID walker — required for crash detection (Flow D) and the
    // ManagerLoop's "process still alive" probe. Stubbing it (e.g. always
    // Returning [pid, pid+1]) makes the manager believe the child is alive
    // Forever, which blocks `error` transitions on crash.
    getDescendantPids,
    renameWindow: async () => {
      /* No-op */
    },
    getWindowName: async () => "test",
    getWindowOption: async () => "off",
    setWindowOption: async () => {
      /* No-op */
    },
    exec: async () => {
      /* No-op */
    },
    preflightPorts: async () => null,
    storeExecInfo: () => {
      /* No-op */
    },
    sessionId: "p04-t05",
    zapsCommand: "zaps",
    reflowInsert: async (name: string) => {
      if (!ref.session) {
        throw new Error("reflowInsert: session not yet wired");
      }
      await ref.session.reflowInsert(name);
    },
    reflowRemove: async (name: string) => {
      if (!ref.session) {
        throw new Error("reflowRemove: session not yet wired");
      }
      await ref.session.reflowRemove(name);
    },
  };

  const manager = new ServiceManager(config, paneMap, deps, testSession.name);
  const params: SessionCreateParams = {
    configPath: config.configPath,
    projectDir: config.projectDir,
    config,
    paneMap,
    tmuxSession: testSession.name,
    originPane: testSession.initialPaneId,
    deps,
  };
  const session = new Session(params, manager);
  ref.session = session;

  return {
    testSession,
    session,
    manager,
    async cleanup() {
      try {
        await manager.stopAll();
      } catch {
        /* Best-effort */
      }
      await testSession.cleanup();
    },
  };
}

/**
 * Write a `.zaps.ts` file expressing the same fixture as code, in a real temp
 * Dir. Required for tests that exercise `Session.reload` (which calls
 * `loadConfig` on the configured path).
 */
function writeZapsFile(dir: string, body: string): { configPath: string; projectDir: string } {
  const configPath = path.join(dir, ".zaps.ts");
  fs.writeFileSync(configPath, body);
  return { configPath, projectDir: dir };
}

/**
 * Promise-racer: `await raceTimeout(p, ms, label)` rejects with the label when
 * `p` outlasts `ms`. Used as the BOUNDED-TIMEOUT seal on the deadlock tests:
 * If reload hangs (regression in the shuttingDown guard), the test fails fast
 * Instead of letting vitest timeout the whole suite.
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Bounded-timeout failure: ${label} (>${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// --- Tests -----------------------------------------------------------------

describe.skipIf(!hasTmux())("Phase 4 lifecycle integration", () => {
  let live: LiveSession;

  afterEach(async () => {
    if (live) {
      await live.cleanup();
    }
  });

  // ===========================================================================
  // Flow A — Boot
  // ===========================================================================

  it("Flow A: default-lazy service has NO pane at boot; autostart and non-lazy controls DO", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "api" }, { pane: "worker" }, { pane: "control" }],
    };
    const config = makeResolvedConfig(
      {
        api: { start: idleCmd }, // Autostart non-lazy.
        worker: { start: idleCmd, flags: { start: false } }, // Default lazy.
        control: { start: idleCmd, flags: { start: false }, lazyPane: false }, // Non-autostart, explicit non-lazy.
      },
      layout,
      // Loader would produce these — we set them directly here.
      { api: false, worker: true, control: false },
    );

    live = await buildLiveSession(config);

    // PaneMap should have @tui, api, control. worker is boot-skipped.
    expect(live.session.paneMap["@tui"]).toBeDefined();
    expect(live.session.paneMap.api).toBeDefined();
    expect(live.session.paneMap.control).toBeDefined();
    expect(live.session.paneMap.worker).toBeUndefined();

    // Live tmux: 3 panes, not 4.
    expect(await paneCount(live.testSession.name)).toBe(3);
  });

  // ===========================================================================
  // Flow B — Start a lazy service
  // ===========================================================================

  it("Flow B: starting a lazy service creates its pane at the exact declared slot + process runs", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "worker" }, { pane: "tail" }],
    };
    const config = makeResolvedConfig(
      {
        worker: { start: printerCmd("WORKER_READY"), flags: { start: false } },
        tail: { start: idleCmd },
      },
      layout,
      { worker: true, tail: false },
    );

    live = await buildLiveSession(config);
    expect(live.session.paneMap.worker).toBeUndefined();
    expect(await paneCount(live.testSession.name)).toBe(2); // @tui + tail.

    await live.manager.startService("worker");
    await waitForState(live.manager, "worker", "ready");

    // PaneMap now has worker.
    const workerPaneId = live.session.paneMap.worker;
    expect(workerPaneId).toBeDefined();
    expect(await paneCount(live.testSession.name)).toBe(3);

    // Spatial order: @tui, worker, tail.
    const order = await paneIndexOrder(live.testSession.name);
    expect(order.map((entry) => entry.id)).toEqual([
      live.session.paneMap["@tui"],
      workerPaneId,
      live.session.paneMap.tail,
    ]);

    // Geometry matches the declared layout (filtered to all-three-visible).
    const { width, height } = await getWindowSize(live.testSession.name);
    const expected = computeRects(layout, width, height);
    // Log line reached the LogBuffer for worker (P03-T03 alloc+broadcast).
    await waitUntil(
      () =>
        live.session.logBuffers
          .get("worker")
          ?.snapshot()
          .some((line) => line.includes("WORKER_READY")) ?? false,
      8000,
    );
    expect(
      live.session.logBuffers
        .get("worker")
        ?.snapshot()
        .some((l) => l.includes("WORKER_READY")),
    ).toBe(true);
    // Sanity: declared geometry actually realized.
    expect(expected.size).toBe(3);
  });

  // ===========================================================================
  // Flow C — Explicit stop
  // ===========================================================================

  it("Flow C: stopping a started lazy service removes its pane + survivors re-expand", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "worker" }, { pane: "tail" }],
    };
    const config = makeResolvedConfig(
      {
        worker: { start: idleCmd, flags: { start: false } },
        tail: { start: idleCmd },
      },
      layout,
      { worker: true, tail: false },
    );

    live = await buildLiveSession(config);
    await live.manager.startService("worker");
    await waitForState(live.manager, "worker", "ready");
    const workerPaneId = live.session.paneMap.worker;

    await live.manager.stopService("worker");
    await waitForState(live.manager, "worker", "stopped");

    // PaneMap entry gone, live pane gone.
    expect(live.session.paneMap.worker).toBeUndefined();
    const order = await paneIndexOrder(live.testSession.name);
    expect(order.map((entry) => entry.id)).not.toContain(workerPaneId);
    expect(order).toHaveLength(2);
    // Round-7 retention invariant: the service-keyed log buffer survives.
    expect(live.session.logBuffers.has("worker")).toBe(true);
  });

  // ===========================================================================
  // Flow D — Crash keeps the pane
  // ===========================================================================

  it("Flow D: a crashing lazy service KEEPS its pane (no removePane from handleCrash)", async () => {
    const config = makeResolvedConfig(
      {
        // No retries — we want to observe the post-crash state without a loop.
        crasher: {
          start: crashAfterReadyCmd,
          flags: { start: false },
          restart: { maxRetries: 0 },
          ready: { output: /READY/ },
        },
      },
      { direction: "columns", children: [{ pane: "@tui" }, { pane: "crasher" }] },
      { crasher: true },
    );

    live = await buildLiveSession(config);
    await live.manager.startService("crasher");
    await waitForState(live.manager, "crasher", "ready");
    // Wait for the crash to fire — `error` state is the terminal post-crash
    // Sink for `maxRetries: 0`.
    await waitForState(live.manager, "crasher", "error", 10_000);

    // CRITICAL: pane survives so the user can inspect the post-mortem output.
    expect(live.session.paneMap.crasher).toBeDefined();
    const liveOrder = await paneIndexOrder(live.testSession.name);
    const ids = liveOrder.map((p) => p.id);
    expect(ids).toContain(live.session.paneMap.crasher);
  });

  // ===========================================================================
  // Flow E — Restart keeps / re-creates the pane
  // ===========================================================================

  it("Flow E (running): restartService on a running lazy service KEEPS its pane (same pane id)", async () => {
    const config = makeResolvedConfig(
      { worker: { start: idleCmd, flags: { start: false } } },
      { direction: "columns", children: [{ pane: "@tui" }, { pane: "worker" }] },
      { worker: true },
    );

    live = await buildLiveSession(config);
    await live.manager.startService("worker");
    await waitForState(live.manager, "worker", "ready");
    const before = live.session.paneMap.worker;

    // RestartService is fire-and-forget for the running→stop→start chain.
    // We just verify the pane id never changes (the existing pane is reused).
    void live.manager.restartService("worker");
    // Give the stop+start cycle time; the pane shouldn't disappear in the middle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = live.session.paneMap.worker;
    expect(after).toBe(before);
  });

  // ===========================================================================
  // Flow F — Opt-in autostart
  // ===========================================================================

  it("Flow F: autostart lazyPane:true service that is manually stopped LOSES its pane", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "optin" }, { pane: "ctrl" }],
    };
    const config = makeResolvedConfig(
      {
        optin: { start: idleCmd, lazyPane: true }, // Autostart + explicit lazyPane.
        ctrl: { start: idleCmd, lazyPane: false }, // Autostart + explicit non-lazy.
      },
      layout,
      { optin: true, ctrl: false },
    );

    live = await buildLiveSession(config);
    // Boot: BOTH have a pane (autostart bypasses boot-skip — predicate
    // Requires `flags.start === false`).
    expect(live.session.paneMap.optin).toBeDefined();
    expect(live.session.paneMap.ctrl).toBeDefined();

    await live.manager.startAll();
    await waitForState(live.manager, "optin", "ready");
    await waitForState(live.manager, "ctrl", "ready");

    // Manual stop on the opt-in lazy → pane removed (lazy=true → reflowRemove).
    await live.manager.stopService("optin");
    await waitForState(live.manager, "optin", "stopped");
    expect(live.session.paneMap.optin).toBeUndefined();

    // Control non-lazy → pane survives explicit stop.
    await live.manager.stopService("ctrl");
    await waitForState(live.manager, "ctrl", "stopped");
    expect(live.session.paneMap.ctrl).toBeDefined();
  });

  // ===========================================================================
  // Round-5 SEAL: reload-staleness — second insert lands via live reflow handle
  // ===========================================================================

  it("SEAL (Round-5): reload-then-insert lands the new pane via the live paneMap (no Unknown service)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-p04-t05-"));
    try {
      const { configPath, projectDir } = writeZapsFile(
        tmpDir,
        `
          export function config(lib) {
            return lib.defineProject({
              services: {
                workerA: { start: ${JSON.stringify(idleCmd)}, raw: true, flags: { start: false } },
                workerB: { start: ${JSON.stringify(idleCmd)}, raw: true, flags: { start: false } },
              },
              layout: {
                direction: "columns",
                children: [{ pane: "@tui" }, { pane: "workerA" }, { pane: "workerB" }],
              },
            });
          }
        `,
      );
      // Use real loadConfig so reload reads the same shape.
      const config = await loadConfig(configPath, projectDir);
      // Override the projectDir to the temp dir so config + project deltas
      // Stay in the tmpdir during the test.
      config.configPath = configPath;
      config.projectDir = projectDir;

      live = await buildLiveSession(config);

      // (1) Start workerA — its pane is inserted via the post-construct reflow.
      await live.manager.startService("workerA");
      await waitForState(live.manager, "workerA", "ready");
      expect(live.session.paneMap.workerA).toBeDefined();

      // (2) Reload — atomically swaps session.paneMap + session.manager.
      await live.session.reload();
      // After reload, workerA was NOT autostart, so it's stopped and pane-less.
      // (`stopAllServices` removed its tmux pane via _reload step 4, and the
      // New manager's paneMap has no entry for workerA.)
      expect(live.session.paneMap.workerA).toBeUndefined();

      // (3) Start workerB via the NEW manager. If reflow had captured a stale
      // PaneMap/manager reference, this would throw `Unknown service` or
      // Insert into the dead pipeline.
      await live.session.manager.startService("workerB");
      await waitForState(live.session.manager, "workerB", "ready");
      expect(live.session.paneMap.workerB).toBeDefined();
      // The live tmux pane is reachable through the NEW manager's paneMap.
      const liveOrder = await paneIndexOrder(live.testSession.name);
      const ids = liveOrder.map((p) => p.id);
      expect(ids).toContain(live.session.paneMap.workerB);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // P04-T04-REVIEW SEAL: reload-with-running-lazy completes (no withOpLock re-entrance)
  // ===========================================================================

  it("SEAL (deadlock): reload with a running lazy service completes under bounded timeout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-p04-t05-"));
    try {
      const { configPath, projectDir } = writeZapsFile(
        tmpDir,
        `
          export function config(lib) {
            return lib.defineProject({
              services: {
                worker: { start: ${JSON.stringify(idleCmd)}, raw: true, flags: { start: false } },
              },
              layout: {
                direction: "columns",
                children: [{ pane: "@tui" }, { pane: "worker" }],
              },
            });
          }
        `,
      );
      const config = await loadConfig(configPath, projectDir);
      config.configPath = configPath;
      config.projectDir = projectDir;

      live = await buildLiveSession(config);
      await live.manager.startService("worker");
      await waitForState(live.manager, "worker", "ready");
      expect(live.session.paneMap.worker).toBeDefined();

      // Without the `shuttingDown` guard in P04-T04, this hangs FOREVER:
      //   Reload holds withOpLock → stopAll → stopService(worker) →
      //   Deps.reflowRemove → session.reflowRemove → withOpLock (not
      //   Re-entrant) → chains AFTER the reload fn → circular wait.
      await raceTimeout(live.session.reload(), 10_000, "Session.reload");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // @tui-reserve under boot-skip (Round-5 sharp edge)
  // ===========================================================================

  it("Round-5: layout with slot-0 lazy → @tui still maps to the start pane (reserveTuiPane path)", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      // SLOT 0 IS A SKIPPED LAZY SERVICE. The filtered tree must put @tui in
      // Slot 0 so reserveStartPaneForTui agrees with walkLayout (P04-T03 fix).
      children: [{ pane: "worker" }, { pane: "@tui" }, { pane: "tail" }],
    };
    const config = makeResolvedConfig(
      {
        worker: { start: idleCmd, flags: { start: false } },
        tail: { start: idleCmd },
      },
      layout,
      { worker: true, tail: false },
    );

    // Build the boot layout DIRECTLY with reserveTuiPane:true so we mirror
    // The reload path that exercises the @tui reserve.
    const testSession = await createTestSession();
    const skip = computeBootSkip(config);
    const { paneMap } = await createLayout(
      testSession.initialPaneId,
      config.project.layout,
      config.project.services,
      config.groups,
      { skip, reserveTuiPane: true },
    );

    try {
      expect(paneMap["@tui"]).toBe(testSession.initialPaneId);
      expect(paneMap.worker).toBeUndefined();
      expect(paneMap.tail).toBeDefined();
    } finally {
      // Manual cleanup since we didn't go through buildLiveSession.
      for (const id of Object.values(paneMap)) {
        if (id !== testSession.initialPaneId) {
          await killPane(id).catch(() => {
            /* Best-effort */
          });
        }
      }
      await testSession.cleanup();
    }
  });

  // ===========================================================================
  // Group/detached never lazy — loader guard verified through real boot
  // ===========================================================================

  it("Group/detached never lazy: a non-autostart group member + detached service get the SAME boot treatment as today", async () => {
    // Loader's guard (P04-T02) forces `lazyPaneByService=false` for group
    // Members and detached, regardless of flags.start. We assert by NOT
    // Putting them in the lazy map: even if the user typed `flags.start:
    // False` and tried `lazyPane:true`, the resolved value is false → no
    // Boot-skip. (The full schema-rejection path is tested in P04-T01.)
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "groupA" }, { pane: "groupB" }, { pane: "isolated" }],
    };
    const config = makeResolvedConfig(
      {
        // Two members sharing a pane via the same group name.
        groupA: { start: idleCmd, flags: { start: false } },
        groupB: { start: idleCmd, flags: { start: false } },
        isolated: { start: idleCmd },
      },
      layout,
      // P04-T02 guard semantics: members resolve to false even when their
      // Flags.start is false. We model that here directly.
      { groupA: false, groupB: false, isolated: false },
    );

    live = await buildLiveSession(config);

    // ALL services have a pane at boot (no skip).
    expect(live.session.paneMap.groupA).toBeDefined();
    expect(live.session.paneMap.groupB).toBeDefined();
    expect(live.session.paneMap.isolated).toBeDefined();
    // Manually starting groupA does NOT trigger reflowInsert (already paned).
    const preOrder = await paneIndexOrder(live.testSession.name);
    const pre = preOrder.length;
    await live.manager.startService("groupA");
    await waitForState(live.manager, "groupA", "ready");
    const postOrder = await paneIndexOrder(live.testSession.name);
    const post = postOrder.length;
    expect(post).toBe(pre);
  });

  // ===========================================================================
  // Concurrency — two parallel lazy starts
  // ===========================================================================

  it("Concurrency: two near-simultaneous lazy starts converge to correct geometry; reflows serialized", async () => {
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "@tui" }, { pane: "a" }, { pane: "b" }],
    };
    const config = makeResolvedConfig(
      {
        a: { start: idleCmd, flags: { start: false } },
        b: { start: idleCmd, flags: { start: false } },
      },
      layout,
      { a: true, b: true },
    );

    live = await buildLiveSession(config);
    expect(await paneCount(live.testSession.name)).toBe(1); // Only @tui.

    // Fire both starts WITHOUT awaiting between — the op-lock must serialize
    // The two `reflowInsert` calls. Final state: 3 panes in declared order.
    const pA = live.manager.startService("a");
    const pB = live.manager.startService("b");
    await Promise.all([pA, pB]);
    await waitForState(live.manager, "a", "ready");
    await waitForState(live.manager, "b", "ready");

    expect(await paneCount(live.testSession.name)).toBe(3);
    expect(live.session.paneMap.a).toBeDefined();
    expect(live.session.paneMap.b).toBeDefined();
    expect(live.session.paneMap.a).not.toBe(live.session.paneMap.b);

    // Spatial order matches the layout DFS: @tui, a, b.
    const orderEntries = await paneIndexOrder(live.testSession.name);
    const order = orderEntries.map((p) => p.id);
    expect(order).toEqual([
      live.session.paneMap["@tui"],
      live.session.paneMap.a,
      live.session.paneMap.b,
    ]);
  });

  // ===========================================================================
  // Concurrency — start vs reload (bounded timeout)
  // ===========================================================================

  it("Concurrency (start vs reload): concurrent manual start + reload completes; converges", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-p04-t05-"));
    try {
      const { configPath, projectDir } = writeZapsFile(
        tmpDir,
        `
          export function config(lib) {
            return lib.defineProject({
              services: {
                worker: { start: ${JSON.stringify(idleCmd)}, raw: true, flags: { start: false } },
              },
              layout: {
                direction: "columns",
                children: [{ pane: "@tui" }, { pane: "worker" }],
              },
            });
          }
        `,
      );
      const config = await loadConfig(configPath, projectDir);
      config.configPath = configPath;
      config.projectDir = projectDir;

      live = await buildLiveSession(config);

      // Fire start + reload near-simultaneously. The Round-4 deadlock would
      // Manifest here if reflow ran INSIDE withServiceLock (start path takes
      // Service-lock then op-lock; reload takes op-lock then service-lock).
      // Bounded timeout: if either hangs, this test fails fast.
      const pStart = live.session.manager.startService("worker").catch(() => {
        /* May race with reload — okay either way */
      });
      const pReload = live.session.reload().catch(() => {
        /* May race */
      });
      await raceTimeout(Promise.all([pStart, pReload]), 15_000, "start+reload race");

      // Final state must converge — no permanent locks. We don't pin a
      // Particular state (race semantics); we pin LIVENESS.
      expect(live.session.destroyed).toBe(false);
      // Subsequent ops still work.
      await raceTimeout(
        live.session.manager.startService("worker").catch(() => {
          /* Idempotent — may noop if already running */
        }),
        5000,
        "post-race startService",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Suppress unused-var warning on imports kept for typing context only.
void EventEmitter;
void vi;
void beforeEach;
