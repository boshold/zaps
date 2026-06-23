import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryActions, ResolvedConfig, ServiceConfig } from "../../../src/config/types.js";
import type { ServiceManagerDeps } from "../../../src/lib/service/manager.js";
import { ServiceManager, diffOutput } from "../../../src/lib/service/manager.js";
import type { ServiceStatus } from "../../../src/lib/service/types.js";

vi.mock("../../../src/lib/probe.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/lib/probe.js")>()),
  probePort: vi.fn().mockResolvedValue(undefined),
}));

const { probePort } = (await import("../../../src/lib/probe.js")) as unknown as {
  probePort: ReturnType<typeof vi.fn>;
};

// --- Mock deps factory ---

function createMockDeps(): ServiceManagerDeps {
  return {
    sendKeys: vi.fn<ServiceManagerDeps["sendKeys"]>().mockResolvedValue(),
    sendCtrlC: vi.fn<ServiceManagerDeps["sendCtrlC"]>().mockResolvedValue(),
    panePid: vi.fn<ServiceManagerDeps["panePid"]>().mockResolvedValue(1000),
    detectPorts: vi.fn<ServiceManagerDeps["detectPorts"]>().mockResolvedValue([]),
    capturePane: vi.fn<ServiceManagerDeps["capturePane"]>().mockResolvedValue(""),
    // Default: only root PID (no children) = process exited
    getDescendantPids: vi.fn<ServiceManagerDeps["getDescendantPids"]>().mockResolvedValue([1000]),
    renameWindow: vi.fn<ServiceManagerDeps["renameWindow"]>().mockResolvedValue(),
    getWindowName: vi.fn<ServiceManagerDeps["getWindowName"]>().mockResolvedValue("bash"),
    getWindowOption: vi.fn<ServiceManagerDeps["getWindowOption"]>().mockResolvedValue("on"),
    setWindowOption: vi.fn<ServiceManagerDeps["setWindowOption"]>().mockResolvedValue(),
    exec: vi.fn<ServiceManagerDeps["exec"]>().mockResolvedValue(),
    preflightPorts: vi.fn<ServiceManagerDeps["preflightPorts"]>().mockResolvedValue(null),
    storeExecInfo: vi.fn(),
    sessionId: "test-session-id",
    zapsCommand: "zaps",
    reflowInsert: vi.fn<ServiceManagerDeps["reflowInsert"]>().mockResolvedValue(),
    reflowRemove: vi.fn<ServiceManagerDeps["reflowRemove"]>().mockResolvedValue(),
  };
}

// --- Config helpers ---

function makeConfig(
  services: Record<string, ServiceConfig>,
  hooks?: ResolvedConfig["project"]["hooks"],
): ResolvedConfig {
  return {
    project: {
      name: "test-project",
      services,
      hooks,
    },
    configPath: "/test/.zaps.ts",
    projectDir: "/test",
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
}

function makePaneMap(names: string[]): Record<string, string> {
  const map: Record<string, string> = { "@tui": "%tui" };
  for (const name of names) {
    map[name] = `%${name}`;
  }
  return map;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// StartAll
// =============================================================================

describe("startAll", () => {
  it("starts 3 services in topo order, each level waits for ready", async () => {
    const config = makeConfig({
      db: { start: "start-db", ready: { port: 5432 } },
      api: { start: "start-api", dependsOn: ["db"], ready: { port: 3000 } },
      frontend: { start: "start-fe", dependsOn: ["api"], ready: { port: 8080 } },
    });
    const paneMap = makePaneMap(["db", "api", "frontend"]);
    const deps = createMockDeps();

    // Track call order
    const callOrder: string[] = [];
    deps.sendKeys = vi.fn(async (target: string) => {
      callOrder.push(target);
    });

    // Each detectPorts call returns the service's port (simulating ready)
    deps.detectPorts = vi.fn(async (target: string) => {
      if (target === "%db") {
        return [5432];
      }
      if (target === "%api") {
        return [3000];
      }
      if (target === "%frontend") {
        return [8080];
      }
      return [];
    });

    // Descendants > 1 means process is running (for crash monitor)
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startAll();

    // Advance timers to let ready checks complete
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // DB started first, then API, then frontend
    expect(callOrder[0]).toBe("%db");
    expect(callOrder[1]).toBe("%api");
    expect(callOrder[2]).toBe("%frontend");

    // All should be ready
    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");
    expect(mgr.getStatus("frontend").state).toBe("ready");
  });

  it("skips services with autostart: false", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      worker: { start: "start-worker", flags: { start: false } },
    });
    const paneMap = makePaneMap(["db", "worker"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("worker").state).toBe("stopped");
    expect(deps.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("treats a non-autostart dependency as satisfied (no circular-dependency throw)", async () => {
    const config = makeConfig({
      db: { start: "start-db", flags: { start: false } },
      api: { start: "start-api", dependsOn: ["db"] },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();

    expect(mgr.getStatus("api").state).toBe("ready");
    expect(mgr.getStatus("db").state).toBe("stopped");
  });

  it("dedupes concurrent startAll calls so hooks fire once", async () => {
    const onBeforeStart = vi.fn();
    const onStart = vi.fn();
    const config = makeConfig({ svc: { start: "start-svc" } }, { onBeforeStart, onStart });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const p1 = mgr.startAll();
    const p2 = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([p1, p2]);

    expect(onBeforeStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(deps.sendKeys).toHaveBeenCalledTimes(1);

    // Promise cleared on settle: a later startAll runs the hooks again
    await mgr.startAll();
    expect(onBeforeStart).toHaveBeenCalledTimes(2);
  });

  it("records lastError + emits stateChange on a dependent when its dependency fails", async () => {
    const config = makeConfig({
      a: { start: "start-a", ready: { output: /NEVER_MATCHES/u } },
      b: { start: "start-b", dependsOn: ["a"] },
    });
    const paneMap = makePaneMap(["a", "b"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    deps.capturePane = vi.fn().mockResolvedValue("no match here");

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const changed: { name: string; lastError?: string }[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      changed.push({ name, lastError: status.lastError });
    });

    const promise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(65_000);
    await promise;

    // A failed its ready check
    expect(mgr.getStatus("a").state).toBe("error");
    // B was never started; surfaced the dependency failure
    expect(mgr.getStatus("b").state).toBe("stopped");
    expect(mgr.getStatus("b").lastError).toBe('Dependency "a" not ready');
    expect(changed.some((e) => e.name === "b" && e.lastError === 'Dependency "a" not ready')).toBe(
      true,
    );
  });

  it("abortStartAll stops launching subsequent topo levels", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api", dependsOn: ["db"] },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    // Block db mid-start so the abort lands before level 1 (api) launches.
    let releaseDb!: () => void;
    const dbReleased = new Promise<void>((resolve) => {
      releaseDb = resolve;
    });
    let dbReached!: () => void;
    const dbStarted = new Promise<void>((resolve) => {
      dbReached = resolve;
    });
    deps.sendKeys = vi.fn(async (target: string) => {
      if (target === "%db") {
        dbReached();
        await dbReleased;
      }
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startAll();
    await dbStarted;
    mgr.abortStartAll();
    releaseDb();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith("%db", expect.anything());
    expect(deps.sendKeys).not.toHaveBeenCalledWith("%api", expect.anything());
    expect(mgr.getStatus("api").state).toBe("stopped");
  });

  it("abortStartAll skips the onStart hook for the aborted run", async () => {
    const onStart = vi.fn();
    const config = makeConfig({ db: { start: "start-db" } }, { onStart });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    let releaseDb!: () => void;
    const dbReleased = new Promise<void>((resolve) => {
      releaseDb = resolve;
    });
    let dbReached!: () => void;
    const dbStarted = new Promise<void>((resolve) => {
      dbReached = resolve;
    });
    deps.sendKeys = vi.fn(async (target: string) => {
      if (target === "%db") {
        dbReached();
        await dbReleased;
      }
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startAll();
    await dbStarted;
    mgr.abortStartAll();
    releaseDb();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(onStart).not.toHaveBeenCalled();
  });
});

// =============================================================================
// StopAll
// =============================================================================

describe("stopAll", () => {
  it("stops in reverse topo order and calls hooks.onStop", async () => {
    const onStop = vi.fn();
    const config = makeConfig(
      {
        db: { start: "start-db" },
        api: { start: "start-api", dependsOn: ["db"] },
      },
      { onStop },
    );
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();
    // Process is running until Ctrl-C
    let apiStopped = false;
    let dbStopped = false;

    deps.getDescendantPids = vi.fn(async (rootPid: number) => {
      // After sendCtrlC, return only root
      if (rootPid === 1001 && apiStopped) {
        return [1001];
      }
      if (rootPid === 1000 && dbStopped) {
        return [1000];
      }
      return [rootPid, rootPid + 100];
    });

    deps.panePid = vi.fn(async (target: string) => (target === "%api" ? 1001 : 1000));

    deps.sendCtrlC = vi.fn(async (target: string) => {
      if (target === "%api") {
        apiStopped = true;
      }
      if (target === "%db") {
        dbStopped = true;
      }
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // First start them
    const startPromise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(5000);
    await startPromise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");

    // Now stop all
    const stopOrder: string[] = [];
    const origSendCtrlC = deps.sendCtrlC;
    deps.sendCtrlC = vi.fn(async (target: string) => {
      stopOrder.push(target);
      await origSendCtrlC(target);
    });

    const stopPromise = mgr.stopAll();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopPromise;

    // API (dependent) stops before DB (dependency)
    expect(stopOrder[0]).toBe("%api");
    expect(stopOrder[1]).toBe("%db");

    expect(mgr.getStatus("db").state).toBe("stopped");
    expect(mgr.getStatus("api").state).toBe("stopped");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("restores automatic-rename when originally on", async () => {
    const config = makeConfig({ db: { start: "start-db" } });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getWindowOption = vi.fn<ServiceManagerDeps["getWindowOption"]>().mockResolvedValue("on");
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);

    // Clear mocks so we only assert calls made during stopAll
    vi.mocked(deps.renameWindow).mockClear();

    const stopPromise = mgr.stopAll();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopPromise;

    expect(deps.setWindowOption).toHaveBeenCalledWith("%tui", "automatic-rename", "on");
    expect(deps.renameWindow).not.toHaveBeenCalled();
  });

  it("does not restore automatic-rename when originally off", async () => {
    const config = makeConfig({ db: { start: "start-db" } });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getWindowOption = vi.fn<ServiceManagerDeps["getWindowOption"]>().mockResolvedValue("off");
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);

    const stopPromise = mgr.stopAll();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopPromise;

    expect(deps.setWindowOption).not.toHaveBeenCalled();
  });

  it("dedupes concurrent calls and both await the single in-flight stop", async () => {
    const config = makeConfig({ db: { start: "start-db" } });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);

    const p1 = mgr.stopAll();
    const p2 = mgr.stopAll(); // Joins the in-flight run rather than returning early
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([p1, p2]);

    // SendCtrlC should only be called once (single execution of the stop run)
    expect(deps.sendCtrlC).toHaveBeenCalledTimes(1);
    // The joined caller waited for the stop to actually complete.
    expect(mgr.getStatus("db").state).toBe("stopped");
  });
});

// =============================================================================
// StartService
// =============================================================================

describe("startService", () => {
  it("resolves env with runtime context (deps ports)", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: {
        start: "start-api",
        dependsOn: ["db"],
        env: (ctx) => ({ DB_PORT: String(ctx.services.db?.port ?? "") }),
      },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();

    deps.detectPorts = vi.fn(async (target: string) => {
      if (target === "%db") {
        return [5432];
      }
      if (target === "%api") {
        return [3000];
      }
      return [];
    });
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start db first
    const dbPromise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await dbPromise;

    // Now start api
    const apiPromise = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    await apiPromise;

    // In wrapper mode, env is stored via storeExecInfo, not in sendKeys
    expect(deps.storeExecInfo).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({
        command: "start-api",
        env: expect.objectContaining({ DB_PORT: "5432" }),
      }),
    );
    const apiCall = (deps.sendKeys as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "%api",
    );
    expect(apiCall).toBeDefined();
    expect(apiCall?.[1]).toBe("zaps -s test-session-id exec-service api");
  });

  it("sends correct command string to pane", async () => {
    const config = makeConfig({
      svc: { start: "npm run dev", env: { PORT: "3000" } },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.storeExecInfo).toHaveBeenCalledWith(
      "svc",
      expect.objectContaining({
        command: "npm run dev",
        cwd: "/test",
        env: { PORT: "3000" },
      }),
    );
    expect(deps.sendKeys).toHaveBeenCalledWith("%svc", "zaps -s test-session-id exec-service svc");
  });

  it("transitions through stopped -> starting -> ready and emits stateChange", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const events: { name: string; state: string }[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      events.push({ name, state: status.state });
    });

    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(events).toEqual([
      { name: "svc", state: "starting" },
      { name: "svc", state: "ready" },
    ]);
  });

  it("fails fast with lastError on a port pre-flight conflict (B2)", async () => {
    const config = makeConfig({ svc: { start: "start-svc", ready: { port: 5432 } } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.preflightPorts = vi
      .fn<ServiceManagerDeps["preflightPorts"]>()
      .mockResolvedValue("Port 5432 already in use (pid 1234 postgres)");

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await expect(mgr.startService("svc")).rejects.toThrow(
      "Port 5432 already in use (pid 1234 postgres)",
    );

    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").lastError).toBe("Port 5432 already in use (pid 1234 postgres)");
    // Start command was never sent.
    expect(deps.sendKeys).not.toHaveBeenCalled();
  });

  it("sets readySince on ready and clears on stop", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => {
      if (processRunning) {
        return [1000, 2000];
      }
      return [1000];
    });
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").readySince).toBeTypeOf("number");

    // Stop
    processRunning = true;
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(mgr.getStatus("svc").readySince).toBeUndefined();
  });

  it("throws when dependency is not ready", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api", dependsOn: ["db"] },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Try to start api without db being ready
    await expect(mgr.startService("api")).rejects.toThrow(
      'Dependency "db" is not ready for service "api"',
    );
  });

  it("handles command as function", async () => {
    const config = makeConfig({
      svc: { start: () => "dynamic-cmd" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith("%svc", "zaps -s test-session-id exec-service svc");
  });

  it("guards against double-start when already starting", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start twice concurrently
    const p1 = mgr.startService("svc");
    const p2 = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([p1, p2]);

    // SendKeys should only be called once
    expect(deps.sendKeys).toHaveBeenCalledTimes(1);
    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("guards against double-start when already ready", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("svc").state).toBe("ready");

    // Second start should be a no-op
    await mgr.startService("svc");
    expect(deps.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("returns noop:true when starting an already-ready service", async () => {
    const config = makeConfig({ svc: { start: "start-svc" } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    const result = await mgr.startService("svc");
    expect(result).toEqual({ noop: true });
  });

  it("returns noop:true when starting an unavailable service (no action)", async () => {
    const config = makeConfig({ svc: { start: "start-svc" } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    mgr.getStatus("svc").state = "unavailable";

    const events: string[] = [];
    mgr.on("stateChange", (name: string) => events.push(name));

    const result = await mgr.startService("svc");
    expect(result).toEqual({ noop: true });
    expect(deps.sendKeys).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it.each(["stopped", "stopping", "error", "unavailable"] as const)(
    "stop on %s is an idempotent no-op (no throw, no stateChange)",
    async (state) => {
      const config = makeConfig({ svc: { start: "start-svc" } });
      const paneMap = makePaneMap(["svc"]);
      const deps = createMockDeps();

      const mgr = new ServiceManager(config, paneMap, deps, "test-session");
      mgr.getStatus("svc").state = state;

      const events: string[] = [];
      mgr.on("stateChange", (name: string) => events.push(name));

      const result = await mgr.stopService("svc");
      expect(result).toEqual({ noop: true });
      expect(mgr.getStatus("svc").state).toBe(state);
      expect(deps.sendCtrlC).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    },
  );

  it("stops a service in restarting state (restarting -> stopping -> stopped)", async () => {
    const config = makeConfig({ svc: { start: "start-svc" } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    mgr.getStatus("svc").state = "restarting";

    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    const result = await stopPromise;

    expect(result).toEqual({ noop: false });
    expect(mgr.getStatus("svc").state).toBe("stopped");
    expect(deps.sendCtrlC).toHaveBeenCalledWith("%svc");
  });

  it("uses run field when start is not set", async () => {
    const config = makeConfig({
      svc: { run: "run-cmd" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith("%svc", "zaps -s test-session-id exec-service svc");
  });

  it("uses service-level cwd instead of projectDir when set", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", cwd: "/custom/path" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.storeExecInfo).toHaveBeenCalledWith(
      "svc",
      expect.objectContaining({ cwd: "/custom/path" }),
    );
    expect(deps.sendKeys).toHaveBeenCalledWith("%svc", "zaps -s test-session-id exec-service svc");
  });

  it("uses inline env when raw: true", async () => {
    const config = makeConfig({
      svc: { start: "npm run dev", env: { PORT: "3000" }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.storeExecInfo).not.toHaveBeenCalled();
    expect(deps.sendKeys).toHaveBeenCalledWith("%svc", "cd \"/test\" && PORT='3000' npm run dev");
  });
});

// =============================================================================
// StopService
// =============================================================================

describe("stopService", () => {
  it("sends Ctrl-C, waits for exit, transitions ready -> stopping -> stopped", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    // Process running initially
    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => {
      if (processRunning) {
        return [1000, 2000];
      }
      return [1000];
    });

    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start first
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    const events: { name: string; state: string }[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      events.push({ name, state: status.state });
    });

    // Reset processRunning to simulate running service
    processRunning = true;

    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(deps.sendCtrlC).toHaveBeenCalledWith("%svc");
    expect(events).toEqual([
      { name: "svc", state: "stopping" },
      { name: "svc", state: "stopped" },
    ]);
  });

  it("falls back to SIGKILL after timeout", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    // Process never exits gracefully
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start first
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    // Mock process.kill
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopPromise = mgr.stopService("svc");
    // Advance past the 5s stop timeout + poll intervals
    await vi.advanceTimersByTimeAsync(10_000);
    await stopPromise;

    // Should have tried to kill PID 2000 (child, not root)
    expect(killSpy).toHaveBeenCalledWith(2000, "SIGKILL");
    expect(mgr.getStatus("svc").state).toBe("stopped");

    killSpy.mockRestore();
  });
});

// =============================================================================
// RestartService
// =============================================================================

describe("restartService", () => {
  it("stops then starts the service", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    let phase: "running" | "stopping" | "stopped" | "restarted" = "running";

    deps.getDescendantPids = vi.fn(async () => {
      // During stop phase, return only root to signal process exited
      if (phase === "stopping" || phase === "stopped") {
        return [1000];
      }
      // Otherwise, process is running
      return [1000, 2000];
    });

    deps.sendCtrlC = vi.fn(async () => {
      phase = "stopping";
    });

    // After sendKeys for restart, mark as restarted (running again)
    deps.sendKeys = vi.fn(async () => {
      if (phase === "stopped") {
        phase = "restarted";
      }
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start first
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Reset to running phase for restart
    phase = "running";

    // Override sendCtrlC to transition to stopping, then sendKeys to transition back
    deps.sendCtrlC = vi.fn(async () => {
      phase = "stopping";
    });
    deps.sendKeys = vi.fn(async () => {
      phase = "restarted";
    });
    deps.getDescendantPids = vi.fn(async () => {
      if (phase === "stopping") {
        return [1000]; // Exited
      }
      return [1000, 2000]; // Running
    });

    // Restart
    const restartPromise = mgr.restartService("svc");
    await vi.advanceTimersByTimeAsync(10_000);
    await restartPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(deps.sendCtrlC).toHaveBeenCalled();
  });

  it("resets retry count to 0", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3 } },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    // Manually set retryCount to simulate retries
    const status = mgr.getStatus("svc");
    status.retryCount = 2;

    // Stop it
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    // Process running again for restart
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const restartPromise = mgr.restartService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await restartPromise;

    expect(mgr.getStatus("svc").retryCount).toBe(0);
  });
});

// =============================================================================
// Crash recovery
// =============================================================================

describe("crash recovery", () => {
  it("auto-restarts crashed service with backoff", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 1000 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let startCount = 0;
    let running = true;

    // The pane process is running only after a start command is sent; a crash
    // Sets `running = false` and the restart's waitForPaneExit then passes.
    deps.sendKeys = vi.fn(async () => {
      startCount += 1;
      running = true;
    });

    deps.getDescendantPids = vi.fn(async () => (running ? [1000, 2000] : [1000]));

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start service
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(startCount).toBe(1);

    // Simulate crash — process gone
    running = false;

    // Wait for crash monitor poll (2s), backoff (1000ms), pane-exit wait, restart
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2000);

    expect(startCount).toBe(2);
    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").retryCount).toBe(1);
  });

  it("transitions to error when retries exhausted", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 1, backoff: 100 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let crashCount = 0;
    deps.getDescendantPids = vi.fn(async () => {
      // First start: running, then crashes
      if (crashCount > 0) {
        return [1000]; // Crashed
      }
      return [1000, 2000]; // Running
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start service
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");

    // First crash
    crashCount = 1;
    await vi.advanceTimersByTimeAsync(2500);

    // After backoff, it restarts — but immediately crashes again
    // Process is running momentarily during start
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    await vi.advanceTimersByTimeAsync(1000);

    // Service restarted, now ready again
    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").retryCount).toBe(1);

    // Second crash — retries exhausted (maxRetries: 1)
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);
    await vi.advanceTimersByTimeAsync(2500);

    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").lastError).toBe("Process exited unexpectedly");
  });

  it("manual restart after error works and resets counter", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 0 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    // Start -> crash immediately (maxRetries: 0 means no auto-restart)
    let crashed = false;
    deps.getDescendantPids = vi.fn(async () => {
      if (crashed) {
        return [1000];
      }
      return [1000, 2000];
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");

    // Simulate crash
    crashed = true;
    await vi.advanceTimersByTimeAsync(2500);

    expect(mgr.getStatus("svc").state).toBe("error");

    // Manual restart
    crashed = false;
    const restartPromise = mgr.restartService("svc");
    await vi.advanceTimersByTimeAsync(5000);
    await restartPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").retryCount).toBe(0);
  });

  it("transitions to error with lastError when the restart attempt fails", async () => {
    const config = makeConfig({
      dep: { start: "start-dep", raw: true },
      svc: { start: "start-svc", dependsOn: ["dep"], restart: { maxRetries: 3, backoff: 100 } },
    });
    const paneMap = makePaneMap(["dep", "svc"]);
    const deps = createMockDeps();
    // Keep processes "running" so the background poll monitor never fires;
    // We drive the crash explicitly via handleExecExited.
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    await mgr.startService("dep");
    const svcStart = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await svcStart;
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Dependency goes down — the restart's dep check will throw.
    mgr.getStatus("dep").state = "error";

    const changed: { name: string; state: string }[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      changed.push({ name, state: status.state });
    });

    mgr.handleExecExited("svc", 1, null);
    expect(mgr.getStatus("svc").state).toBe("restarting");

    // Crashed process is now gone, so the restart's waitForPaneExit returns fast.
    vi.mocked(deps.getDescendantPids).mockResolvedValue([1000]);

    await vi.advanceTimersByTimeAsync(200);

    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").lastError).toContain('Dependency "dep" is not ready');
    expect(changed.some((e) => e.name === "svc" && e.state === "error")).toBe(true);
  });

  it("does not restart a service stopped during crash-backoff", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 1000 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let stopRequested = false;
    deps.getDescendantPids = vi.fn(async () => (stopRequested ? [1000] : [1000, 2000]));
    deps.sendCtrlC = vi.fn(async () => {
      stopRequested = true;
    });

    let startCount = 0;
    deps.sendKeys = vi.fn(async () => {
      startCount += 1;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;
    expect(startCount).toBe(1);

    // Crash → enters backoff (restarting)
    mgr.handleExecExited("svc", 1, null);
    expect(mgr.getStatus("svc").state).toBe("restarting");

    // Stop while in backoff
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(mgr.getStatus("svc").state).toBe("stopped");
    expect(startCount).toBe(1); // No resurrection
  });

  it("does not restart during shutdown (stopAll) while in crash-backoff", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 1000 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let stopRequested = false;
    deps.getDescendantPids = vi.fn(async () => (stopRequested ? [1000] : [1000, 2000]));
    deps.sendCtrlC = vi.fn(async () => {
      stopRequested = true;
    });

    let startCount = 0;
    deps.sendKeys = vi.fn(async () => {
      startCount += 1;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    mgr.handleExecExited("svc", 1, null);
    expect(mgr.getStatus("svc").state).toBe("restarting");

    const stopAllPromise = mgr.stopAll();
    await vi.advanceTimersByTimeAsync(6000);
    await stopAllPromise;

    expect(mgr.getStatus("svc").state).toBe("stopped");
    expect(startCount).toBe(1);
  });

  it("does not restart when monitor generation is superseded during backoff", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 1000 }, raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    let startCount = 0;
    deps.sendKeys = vi.fn(async () => {
      startCount += 1;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    mgr.handleExecExited("svc", 1, null);
    expect(mgr.getStatus("svc").state).toBe("restarting");

    // A superseding operation bumps the generation during backoff
    (mgr as unknown as { monitorGenerations: Map<string, number> }).monitorGenerations.set(
      "svc",
      999,
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(startCount).toBe(1); // Backoff woke but bailed — no restart
  });
});

// =============================================================================
// Crash monitor poll interval
// =============================================================================

describe("crash monitor poll interval", () => {
  it("polls every 2s for raw-mode services", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    // Clear call count after startup
    (deps.getDescendantPids as ReturnType<typeof vi.fn>).mockClear();

    // Advance 2.5s — should have polled once (2s interval)
    await vi.advanceTimersByTimeAsync(2500);
    expect(deps.getDescendantPids).toHaveBeenCalled();
  });

  it("polls every 10s for wrapper-mode services", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    // Clear call count after startup
    (deps.getDescendantPids as ReturnType<typeof vi.fn>).mockClear();

    // Advance 5s — should NOT have polled yet (10s interval)
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.getDescendantPids).not.toHaveBeenCalled();

    // Advance past 10s total — should have polled
    await vi.advanceTimersByTimeAsync(6000);
    expect(deps.getDescendantPids).toHaveBeenCalled();
  });
});

// =============================================================================
// HandleExecExited
// =============================================================================

describe("handleExecExited", () => {
  it("fails a starting service fast on a wrapper spawn error (E11)", async () => {
    const config = makeConfig({ svc: { start: "start-svc", ready: { output: /NEVER_MATCHES/u } } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.capturePane = vi.fn().mockResolvedValue("no match here");

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const events: { name: string; state: string; lastError?: string }[] = [];
    mgr.on("stateChange", (name: string, status: ServiceStatus) => {
      events.push({ name, state: status.state, lastError: status.lastError });
    });

    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr.getStatus("svc").state).toBe("starting");

    const controller = (
      mgr as unknown as { abortControllers: Map<string, AbortController> }
    ).abortControllers.get("svc");

    mgr.handleExecExited("svc", 127, null, "spawn /bad/cwd ENOENT");

    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").lastError).toBe("spawn /bad/cwd ENOENT");
    expect(controller?.signal.aborted).toBe(true);
    expect(events.some((e) => e.state === "error" && e.lastError === "spawn /bad/cwd ENOENT")).toBe(
      true,
    );

    // The aborted start settles without overwriting the error state.
    await vi.advanceTimersByTimeAsync(600);
    await startPromise;
    expect(mgr.getStatus("svc").state).toBe("error");
  });

  it("triggers error when service is ready with no restart config", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(mgr.getStatus("svc").state).toBe("ready");

    mgr.handleExecExited("svc", 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(mgr.getStatus("svc").state).toBe("error");
    expect(mgr.getStatus("svc").lastError).toBe("Process exited unexpectedly");
  });

  it("triggers restart when service is ready with restart config", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 100 } },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(mgr.getStatus("svc").state).toBe("ready");

    mgr.handleExecExited("svc", 1, "SIGTERM");

    expect(mgr.getStatus("svc").state).toBe("restarting");
    expect(mgr.getStatus("svc").retryCount).toBe(1);
  });

  it("does nothing when service state is not ready", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Service is in "stopped" state initially
    expect(mgr.getStatus("svc").state).toBe("stopped");

    mgr.handleExecExited("svc", 1, null);

    expect(mgr.getStatus("svc").state).toBe("stopped");
  });

  it("increments generation to prevent stale PID poll double-trigger", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", raw: true },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(mgr.getStatus("svc").state).toBe("ready");

    // Simulate crash detection: PID poll returns crashed state
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);

    // HandleExecExited fires first — increments generation
    mgr.handleExecExited("svc", 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(mgr.getStatus("svc").state).toBe("error");

    // Advance past PID poll interval — stale poll should NOT double-trigger
    await vi.advanceTimersByTimeAsync(3000);

    // State remains error (not double-crashed)
    expect(mgr.getStatus("svc").state).toBe("error");
  });
});

// =============================================================================
// URL resolution
// =============================================================================

describe("url resolution", () => {
  it("uses explicit string url from config", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", url: "https://my-app.dev" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("svc").url).toBe("https://my-app.dev");
  });

  it("uses url function from config with service context", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: {
        start: "start-api",
        dependsOn: ["db"],
        url: (ctx) => `http://localhost:${ctx.services.db?.port ?? 0}`,
      },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn(async (target: string) => {
      if (target === "%db") {
        return [5432];
      }
      return [3000];
    });
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const dbPromise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await dbPromise;

    const apiPromise = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    await apiPromise;

    expect(mgr.getStatus("api").url).toBe("http://localhost:5432");
  });

  it("auto-probes HTTP when no url in config", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([3000]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    probePort.mockResolvedValueOnce("http://localhost:3000");

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(probePort).toHaveBeenCalledWith([3000]);
    expect(mgr.getStatus("svc").url).toBe("http://localhost:3000");
  });

  it("retries probe and resolves url after delay", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([3000]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    // First call (onServiceReady) fails, second call (monitorUrl) succeeds
    probePort.mockResolvedValueOnce(undefined).mockResolvedValueOnce("http://localhost:3000");

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Track stateChange events to detect when monitorUrl emits
    const urlEvents: (string | undefined)[] = [];
    mgr.on("stateChange", (_name: string, status: ServiceStatus) => {
      urlEvents.push(status.url);
    });

    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // Initial probe failed — url undefined, monitorUrl running in background
    expect(mgr.getStatus("svc").url).toBeUndefined();

    // Advance past monitorUrl sleep (2s)
    await vi.advanceTimersByTimeAsync(2500);

    // Retry probe succeeds
    expect(mgr.getStatus("svc").url).toBe("http://localhost:3000");
  });

  it("sets url to undefined when probe fails", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([5432]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    probePort.mockResolvedValue(undefined);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("svc").url).toBeUndefined();
  });

  it("skips probing for docker services", async () => {
    const config = makeConfig({
      db: {
        docker: { service: "postgres" },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([5432]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("db").url).toBeUndefined();
    expect(probePort).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("skips probing when url: false", async () => {
    const config = makeConfig({
      db: { start: "start-db", url: false },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([5432]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("db").url).toBeUndefined();
    expect(probePort).not.toHaveBeenCalled();
  });

  it("caps monitorUrl retries at 5", async () => {
    const config = makeConfig({
      svc: { start: "start-svc" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.detectPorts = vi.fn().mockResolvedValue([3000]);
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    // Always fail
    probePort.mockResolvedValue(undefined);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // Initial probe (1) + 5 monitor retries = 6 total calls
    // Advance 5 * 2s + buffer
    await vi.advanceTimersByTimeAsync(12_000);

    // 1 initial + 5 retries = 6
    expect(probePort).toHaveBeenCalledTimes(6);
    expect(mgr.getStatus("svc").url).toBeUndefined();
  });

  it("clears url on stop", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", url: "http://localhost:3000" },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").url).toBe("http://localhost:3000");

    processRunning = true;
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(mgr.getStatus("svc").url).toBeUndefined();
  });
});

// =============================================================================
// Docker ready detection
// =============================================================================

describe("docker ready detection", () => {
  it("uses docker-returned ports instead of detectPorts", async () => {
    const config = makeConfig({
      db: { start: "docker compose up postgres", ready: { docker: "postgres" } },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    // DetectPorts would return nothing (docker daemon PIDs aren't descendants)
    deps.detectPorts = vi.fn().mockResolvedValue([]);

    // Mock getContainerInfo via module mock
    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    let callCount = 0;
    spy.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        return { state: "running", health: "healthy", ports: [5432], ids: [] };
      }
      return { state: "created", health: "", ports: [], ids: [] };
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("db").ports).toEqual([5432]);
    // DetectPorts should NOT have been called since docker returned ports
    expect(deps.detectPorts).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("falls back to detectPorts when docker returns no ports", async () => {
    const config = makeConfig({
      db: { start: "docker compose up postgres", ready: { docker: "postgres" } },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    deps.detectPorts = vi.fn().mockResolvedValue([5432]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("db").ports).toEqual([5432]);
    expect(deps.detectPorts).toHaveBeenCalled();

    spy.mockRestore();
  });
});

// =============================================================================
// Docker config
// =============================================================================

describe("docker config", () => {
  it("generates command from docker config when no start/run", async () => {
    const config = makeConfig({
      db: {
        docker: {
          service: "postgres",
          file: "local.docker-compose.yml",
          build: true,
          forceRecreate: true,
          renewVolumes: true,
        },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    // Mock getContainerInfo for docker ready
    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith("%db", "zaps -s test-session-id exec-service db");
    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("db").ports).toEqual([5432]);

    spy.mockRestore();
  });

  it("prefers explicit start over docker config for command", async () => {
    const config = makeConfig({
      db: {
        start: "custom-start",
        docker: { service: "postgres", file: "local.yml" },
        ready: { docker: "postgres", file: "local.yml" },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith("%db", "zaps -s test-session-id exec-service db");

    spy.mockRestore();
  });

  it("derives docker ready from docker config when no explicit ready", async () => {
    const config = makeConfig({
      db: {
        docker: { service: "postgres" },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "healthy", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(spy).toHaveBeenCalled();
    expect(mgr.getStatus("db").state).toBe("ready");

    spy.mockRestore();
  });

  it("passes composeFile from docker config to readyDeps", async () => {
    const config = makeConfig({
      db: {
        docker: { service: "postgres", file: "my-compose.yml" },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // GetContainerInfo should be called with the composeFile and the -p project args
    expect(spy).toHaveBeenCalledWith(
      "postgres",
      "/test",
      "my-compose.yml",
      expect.arrayContaining(["-p"]),
    );

    spy.mockRestore();
  });
});

// =============================================================================
// GetStatus / getAllStatuses
// =============================================================================

describe("getStatus / getAllStatuses", () => {
  it("returns status for a known service", () => {
    const config = makeConfig({ svc: { start: "start-svc" } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const status = mgr.getStatus("svc");

    expect(status.name).toBe("svc");
    expect(status.state).toBe("stopped");
    expect(status.ports).toEqual([]);
    expect(status.retryCount).toBe(0);
  });

  it("throws for unknown service", () => {
    const config = makeConfig({ svc: { start: "start-svc" } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    expect(() => mgr.getStatus("unknown")).toThrow("Unknown service: unknown");
  });

  it("getAllStatuses returns all service statuses", () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api" },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const statuses = mgr.getAllStatuses();

    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.name).toSorted()).toEqual(["api", "db"]);
  });
});

// =============================================================================
// Per-service hooks (onReady / onStop)
// =============================================================================

describe("per-service hooks", () => {
  it("fires onBeforeStart before command is sent", async () => {
    const callOrder: string[] = [];
    const onBeforeStart = vi.fn(() => {
      callOrder.push("onBeforeStart");
    });
    const config = makeConfig({
      svc: { start: "start-svc", onBeforeStart },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    deps.sendKeys = vi.fn(async () => {
      callOrder.push("sendKeys");
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(onBeforeStart).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf("onBeforeStart")).toBeLessThan(callOrder.indexOf("sendKeys"));
  });

  it("catches onBeforeStart errors without failing the service", async () => {
    const onBeforeStart = vi.fn().mockRejectedValue(new Error("hook failed"));
    const config = makeConfig({
      svc: { start: "start-svc", onBeforeStart },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").lastError).toContain("onBeforeStart hook failed");
  });

  it("fires onReady after service becomes ready", async () => {
    const onReady = vi.fn();
    const config = makeConfig({
      svc: { start: "start-svc", onReady },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("fires onStop after service stops", async () => {
    const onStop = vi.fn();
    const config = makeConfig({
      svc: { start: "start-svc", onStop },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    processRunning = true;
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("catches onReady errors without failing the service", async () => {
    const onReady = vi.fn().mockRejectedValue(new Error("hook failed"));
    const config = makeConfig({
      svc: { start: "start-svc", onReady },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Service should still be ready despite hook error
    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").lastError).toContain("onReady hook failed");
  });

  it("catches onStop errors without failing the stop", async () => {
    const onStop = vi.fn().mockRejectedValue(new Error("hook failed"));
    const config = makeConfig({
      svc: { start: "start-svc", onStop },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    processRunning = true;
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    // Service should still be stopped despite hook error
    expect(mgr.getStatus("svc").state).toBe("stopped");
    expect(mgr.getStatus("svc").lastError).toContain("onStop hook failed");
  });
});

// =============================================================================
// BindActions
// =============================================================================

describe("bindActions", () => {
  it("emits taskComplete when runTask succeeds", async () => {
    let capturedActions: LibraryActions | undefined;
    const config = makeConfig({
      db: { start: "start-db" },
    });
    config.project.tasks = {
      migrate: {
        name: "Run migrations",
        run: async () => {
          /* Noop */
        },
      },
    };
    config.bindActions = (actions) => {
      capturedActions = actions;
    };

    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    if (!capturedActions) {
      throw new Error("bindActions was not called");
    }

    const startEvents: { runId: string; taskKey: string; taskName: string }[] = [];
    mgr.on("taskStart", (runId: string, taskKey: string, taskName: string) => {
      startEvents.push({ runId, taskKey, taskName });
    });
    const events: { runId: string; taskKey: string; taskName: string; result: string }[] = [];
    mgr.on("taskComplete", (runId: string, taskKey: string, taskName: string, result: string) => {
      events.push({ runId, taskKey, taskName, result });
    });

    await capturedActions.runTask("migrate");

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({ taskKey: "migrate", taskName: "Run migrations" });
    expect(startEvents[0].runId).toEqual(expect.any(String));
    // The completion is correlated to the same run.
    expect(events).toEqual([
      {
        runId: startEvents[0].runId,
        taskKey: "migrate",
        taskName: "Run migrations",
        result: "success",
      },
    ]);
  });

  it("emits taskComplete with error when runTask fails", async () => {
    let capturedActions: LibraryActions | undefined;
    const config = makeConfig({
      db: { start: "start-db" },
    });
    config.project.tasks = {
      broken: {
        name: "Broken task",
        run: async () => {
          throw new Error("task failed");
        },
      },
    };
    config.bindActions = (actions) => {
      capturedActions = actions;
    };

    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    if (!capturedActions) {
      throw new Error("bindActions was not called");
    }

    const startEvents: { runId: string; taskKey: string; taskName: string }[] = [];
    mgr.on("taskStart", (runId: string, taskKey: string, taskName: string) => {
      startEvents.push({ runId, taskKey, taskName });
    });
    const events: { runId: string; taskKey: string; taskName: string; result: string }[] = [];
    mgr.on("taskComplete", (runId: string, taskKey: string, taskName: string, result: string) => {
      events.push({ runId, taskKey, taskName, result });
    });

    await expect(capturedActions.runTask("broken")).rejects.toThrow("Task 'broken' failed");

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({ taskKey: "broken", taskName: "Broken task" });
    expect(startEvents[0].runId).toEqual(expect.any(String));
    expect(events).toEqual([
      {
        runId: startEvents[0].runId,
        taskKey: "broken",
        taskName: "Broken task",
        result: "error",
      },
    ]);
  });

  it("calls bindActions with working service methods", async () => {
    let capturedActions: LibraryActions | undefined;
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api" },
    });
    config.bindActions = (actions) => {
      capturedActions = actions;
    };

    const paneMap = makePaneMap(["db", "api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const _mgr = new ServiceManager(config, paneMap, deps, "test-session");

    if (!capturedActions) {
      throw new Error("bindActions was not called");
    }
    const actions = capturedActions;

    // IsServiceRunning should return false for stopped service
    expect(actions.isServiceRunning("db")).toBe(false);

    // Start service via actions
    const startPromise = actions.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    // IsServiceRunning should return true for ready service
    expect(actions.isServiceRunning("db")).toBe(true);
    expect(actions.isServiceRunning("api")).toBe(false);
  });
});

// =============================================================================
// DiffOutput
// =============================================================================

describe("diffOutput", () => {
  it("returns all current lines when prev is empty", () => {
    expect(diffOutput([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns new lines after overlap (scrolling)", () => {
    expect(diffOutput(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
  });

  it("returns the appended lines for a plain append (no scroll)", () => {
    expect(diffOutput(["a", "b", "c"], ["a", "b", "c", "d"])).toEqual(["d"]);
  });

  it("returns empty array when captures are identical", () => {
    expect(diffOutput(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("does not re-emit the window when the final line is rewritten in place", () => {
    // Progress bar: only the last line changes — emit nothing (held), not a flood.
    expect(diffOutput(["a", "b", "50%"], ["a", "b", "60%"])).toEqual([]);
  });

  it("emits stable new lines but holds the volatile final line", () => {
    // "done" is stable and new; "100%" is the final (possibly partial) line, held.
    expect(diffOutput(["a", "b", "50%"], ["a", "b", "done", "100%"])).toEqual(["done"]);
  });

  it("returns [] for equal-size captures with zero overlap", () => {
    expect(diffOutput(["x", "y", "z"], ["a", "b", "c"])).toEqual([]);
  });

  it("treats a differently sized capture with no overlap as all-new", () => {
    expect(diffOutput(["x", "y"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("reports nothing for a fully repetitive window", () => {
    expect(diffOutput(["x", "x", "x"], ["x", "x", "x"])).toEqual([]);
  });
});

// =============================================================================
// OnOutput monitoring
// =============================================================================

describe("onOutput monitoring", () => {
  it("calls onOutput with new lines as they appear", async () => {
    const lines: string[] = [];
    const config = makeConfig({
      svc: {
        start: "start-svc",
        onOutput: (line) => {
          lines.push(line);
        },
      },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    let captureContent = "initial output";
    deps.capturePane = vi.fn(async () => captureContent);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Simulate new output appearing
    captureContent = "initial output\nnew line 1\nnew line 2";
    await vi.advanceTimersByTimeAsync(1500);

    expect(lines).toEqual(["new line 1", "new line 2"]);
  });

  it("does not crash service when onOutput throws", async () => {
    const config = makeConfig({
      svc: {
        start: "start-svc",
        onOutput: () => {
          throw new Error("callback error");
        },
      },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    let captureContent = "line1";
    deps.capturePane = vi.fn(async () => captureContent);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // New output triggers throwing callback
    captureContent = "line1\nnew line";
    await vi.advanceTimersByTimeAsync(1500);

    // Service should still be ready
    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("stops monitoring when service stops", async () => {
    const lines: string[] = [];
    const config = makeConfig({
      svc: {
        start: "start-svc",
        onOutput: (line) => {
          lines.push(line);
        },
      },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));

    let captureContent = "initial";
    deps.capturePane = vi.fn(async () => captureContent);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    // Stop the service
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });
    const stopPromise = mgr.stopService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await stopPromise;

    // New output after stop should not trigger callback
    captureContent = "initial\nafter stop";
    await vi.advanceTimersByTimeAsync(2000);

    expect(lines).toEqual([]);
  });
});

// =============================================================================
// RestartWithDockerOverrides
// =============================================================================

describe("restartWithDockerOverrides", () => {
  it("throws for non-docker service", async () => {
    const config = makeConfig({
      api: { start: "node server.js" },
    });
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await expect(mgr.restartWithDockerOverrides("api", { build: true })).rejects.toThrow(
      'Service "api" is not a docker service',
    );
  });

  it("applies overrides and restores original config", async () => {
    const config = makeConfig({
      db: {
        docker: { service: "postgres" },
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi.spyOn(dockerModule, "getContainerInfo");
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start initially so restartService can stop first
    const startPromise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(5000);
    await startPromise;

    // Restart with overrides — stop phase needs descendants to drop
    let processRunning = true;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const restartPromise = mgr.restartWithDockerOverrides("db", {
      build: true,
      forceRecreate: true,
    });
    // Advance enough for stop + start cycles
    await vi.advanceTimersByTimeAsync(15_000);
    await restartPromise;

    // Original config should be restored
    expect(config.project.services.db.docker?.build).toBeUndefined();
    expect(config.project.services.db.docker?.forceRecreate).toBeUndefined();

    spy.mockRestore();
  });

  it("restores original config even on error", async () => {
    const config = makeConfig({
      db: {
        docker: { service: "postgres" },
        dependsOn: ["missing"],
      },
    });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await expect(mgr.restartWithDockerOverrides("db", { build: true })).rejects.toThrow();

    // Original config should still be restored
    expect(config.project.services.db.docker?.build).toBeUndefined();
  });

  it("serializes concurrent rebuilds so no override flags leak (C8)", async () => {
    const config = makeConfig({ db: { docker: { service: "postgres" } } });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();

    const dockerModule = await import("../../../src/lib/docker.js");
    const spy = vi
      .spyOn(dockerModule, "getContainerInfo")
      .mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });

    let processRunning = false;
    deps.getDescendantPids = vi.fn(async () => (processRunning ? [1000, 2000] : [1000]));
    deps.sendKeys = vi.fn(async () => {
      processRunning = true;
    });
    deps.sendCtrlC = vi.fn(async () => {
      processRunning = false;
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Two rebuilds fired concurrently: the second must snapshot the RESTORED
    // Config (not the first's temporary overrides), so nothing leaks.
    const r1 = mgr.restartWithDockerOverrides("db", { build: true });
    const r2 = mgr.restartWithDockerOverrides("db", { forceRecreate: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([r1, r2]);

    expect(config.project.services.db.docker?.build).toBeUndefined();
    expect(config.project.services.db.docker?.forceRecreate).toBeUndefined();
    expect(config.project.services.db.docker?.service).toBe("postgres");

    spy.mockRestore();
  });
});

// =============================================================================
// Cascade Restart (restartWith)
// =============================================================================

describe("cascadeRestart", () => {
  function createCascadeDeps(): ServiceManagerDeps {
    let stopping = false;
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn(async () => (stopping ? [1000] : [1000, 2000]));
    deps.sendCtrlC = vi.fn(async () => {
      stopping = true;
    });
    deps.sendKeys = vi.fn(async () => {
      stopping = false;
    });
    return deps;
  }

  it("restart db → api also restarts", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api", dependsOn: ["db"], restartWith: ["db"] },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createCascadeDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start both services
    const startDb = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(500);
    await startDb;

    const startApi = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(500);
    await startApi;

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");

    (deps.sendKeys as ReturnType<typeof vi.fn>).mockClear();

    const restart = mgr.restartService("db");
    await vi.advanceTimersByTimeAsync(10_000);
    await restart;

    const targets = (deps.sendKeys as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0],
    );
    expect(targets).toContain("%db");
    expect(targets).toContain("%api");
  });

  it("restart cache → api stays (no restartWith for cache)", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      cache: { start: "start-cache" },
      api: { start: "start-api", dependsOn: ["db", "cache"], restartWith: ["db"] },
    });
    const paneMap = makePaneMap(["db", "cache", "api"]);
    const deps = createCascadeDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    for (const name of ["db", "cache", "api"]) {
      const p = mgr.startService(name);
      await vi.advanceTimersByTimeAsync(500);
      await p;
    }

    (deps.sendKeys as ReturnType<typeof vi.fn>).mockClear();

    const restart = mgr.restartService("cache");
    await vi.advanceTimersByTimeAsync(10_000);
    await restart;

    const targets = (deps.sendKeys as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0],
    );
    expect(targets).toContain("%cache");
    expect(targets).not.toContain("%api");
  });

  it("skips stopped services during cascade", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api", dependsOn: ["db"], restartWith: ["db"] },
    });
    const paneMap = makePaneMap(["db", "api"]);
    const deps = createCascadeDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startDb = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(500);
    await startDb;

    expect(mgr.getStatus("api").state).toBe("stopped");

    (deps.sendKeys as ReturnType<typeof vi.fn>).mockClear();

    const restart = mgr.restartService("db");
    await vi.advanceTimersByTimeAsync(10_000);
    await restart;

    const targets = (deps.sendKeys as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0],
    );
    expect(targets).toContain("%db");
    expect(targets).not.toContain("%api");
  });

  it("no double-cascade in nested restarts", async () => {
    const config = makeConfig({
      db: { start: "start-db" },
      api: { start: "start-api", dependsOn: ["db"], restartWith: ["db"] },
      frontend: { start: "start-fe", dependsOn: ["api"], restartWith: ["api"] },
    });
    const paneMap = makePaneMap(["db", "api", "frontend"]);
    const deps = createCascadeDeps();

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    for (const name of ["db", "api", "frontend"]) {
      const p = mgr.startService(name);
      await vi.advanceTimersByTimeAsync(500);
      await p;
    }

    (deps.sendKeys as ReturnType<typeof vi.fn>).mockClear();

    const restart = mgr.restartService("db");
    await vi.advanceTimersByTimeAsync(10_000);
    await restart;

    const targets = (deps.sendKeys as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0],
    );
    expect(targets.filter((t: string) => t === "%db")).toHaveLength(1);
    expect(targets.filter((t: string) => t === "%api")).toHaveLength(1);
    expect(targets.filter((t: string) => t === "%frontend")).toHaveLength(1);
  });
});

// =============================================================================
// Operation mutex
// =============================================================================

describe("operation mutex", () => {
  it("serializes a concurrent stop + start on the same service (in order)", async () => {
    const config = makeConfig({ svc: { start: "start-svc", raw: true } });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let stopRequested = false;
    deps.getDescendantPids = vi.fn(async () => (stopRequested ? [1000] : [1000, 2000]));

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;
    expect(mgr.getStatus("svc").state).toBe("ready");

    const events: string[] = [];
    deps.sendCtrlC = vi.fn(async () => {
      events.push("stop");
      stopRequested = true;
    });
    deps.sendKeys = vi.fn(async () => {
      events.push("start");
      stopRequested = false;
    });

    // Fire both without awaiting between — the mutex must run them in order.
    const pStop = mgr.stopService("svc");
    const pStart = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(6000);
    await Promise.all([pStop, pStart]);

    expect(events).toEqual(["stop", "start"]);
    expect(mgr.getStatus("svc").state).toBe("ready");
  });

  it("does not poison the chain when an operation rejects", async () => {
    const config = makeConfig({ api: { start: "node server.js" } });
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // First op rejects (api is not a docker service) — the rejection reaches the
    // Caller but must not block later operations on the same service.
    await expect(mgr.restartWithDockerOverrides("api", { build: true })).rejects.toThrow(
      "not a docker service",
    );

    const startPromise = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("api").state).toBe("ready");
  });
});

// === Combined (expanded docker) services ===

describe("combined docker services", () => {
  let dockerSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    probePort.mockResolvedValue(undefined);
    // Mock getContainerInfo to return a ready container
    const dockerModule = await import("../../../src/lib/docker.js");
    dockerSpy = vi.spyOn(dockerModule, "getContainerInfo").mockResolvedValue({
      state: "running",
      health: "",
      ports: [5432],
      ids: [],
    }) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
    dockerSpy?.mockRestore();
  });

  function makeCombinedConfig() {
    return makeConfig({
      postgres: {
        docker: { service: "postgres" },
        _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: true },
      },
      redis: {
        docker: { service: "redis" },
        _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: false },
      },
    });
  }

  it("owner sends docker compose up with all services", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const p = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p;

    // In wrapper mode, the docker compose command is stored via storeExecInfo
    const [[, storedExecInfo]] = (deps.storeExecInfo as ReturnType<typeof vi.fn>).mock.calls;
    expect(storedExecInfo?.command).toContain("postgres");
    expect(storedExecInfo?.command).toContain("redis");
    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%infra",
      "zaps -s test-session-id exec-service postgres",
    );
  });

  it("non-owner skips sendKeys when owner is not running", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const p = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(deps.sendKeys).not.toHaveBeenCalled();
  });

  it("non-owner calls exec when owner is ready", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start owner first
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;

    // Now start non-owner
    const p2 = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    expect(deps.exec).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["start", "redis"]),
      expect.any(String),
    );
  });

  it("sets group on status", () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const statuses = mgr.getAllStatuses();
    expect(statuses.find((s) => s.name === "postgres")?.group).toBe("infra");
    expect(statuses.find((s) => s.name === "redis")?.group).toBe("infra");
  });

  it("stop combined uses docker compose stop", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start both
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    const p2 = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    // Stop redis
    const pStop = mgr.stopService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await pStop;

    expect(deps.exec).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["stop", "redis"]),
      expect.any(String),
    );
    // Pane NOT Ctrl-C'd since postgres still running
    expect(deps.sendCtrlC).not.toHaveBeenCalled();
  });

  it("stop last sibling Ctrl-C's pane", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start owner only
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;

    // Stop postgres (redis is stopped → all stopped)
    const pStop = mgr.stopService("postgres");
    await vi.advanceTimersByTimeAsync(5500);
    await pStop;

    expect(deps.exec).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["stop", "postgres"]),
      expect.any(String),
    );
    expect(deps.sendCtrlC).toHaveBeenCalledWith("%infra");
  });

  it("restart combined non-owner uses docker compose restart", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start both
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    const p2 = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    (deps.exec as ReturnType<typeof vi.fn>).mockClear();

    // Restart redis
    const pRestart = mgr.restartService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await pRestart;

    expect(deps.exec).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["restart", "redis"]),
      expect.any(String),
    );
  });

  it("bumps the monitor generation when restarting a combined non-owner (C7)", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    const p2 = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    const gens = (mgr as unknown as { monitorGenerations: Map<string, number> }).monitorGenerations;
    const before = gens.get("redis") ?? 0;

    const pRestart = mgr.restartService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await pRestart;

    expect((gens.get("redis") ?? 0) > before).toBe(true);
  });

  it("Ctrl-C's the owner's pane when the last combined sibling stops (E10)", async () => {
    const config = makeCombinedConfig();
    const deps = createMockDeps();
    // Group not referenced in layout → each child got its OWN pane.
    const paneMap = { "@tui": "%tui", postgres: "%postgres", redis: "%redis" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const p1 = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    const p2 = mgr.startService("redis");
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    // Stop the owner first — redis still running, so no Ctrl-C yet.
    const pStopOwner = mgr.stopService("postgres");
    await vi.advanceTimersByTimeAsync(5500);
    await pStopOwner;
    expect(deps.sendCtrlC).not.toHaveBeenCalled();

    // Stop the non-owner last → all stopped → Ctrl-C the OWNER's pane.
    const pStopRedis = mgr.stopService("redis");
    await vi.advanceTimersByTimeAsync(5500);
    await pStopRedis;

    expect(deps.sendCtrlC).toHaveBeenCalledWith("%postgres");
    expect(deps.sendCtrlC).not.toHaveBeenCalledWith("%redis");
  });

  it("crash monitor checks docker container status for combined services", async () => {
    const config = makeCombinedConfig();
    // Use raw mode for 2s poll interval in crash monitor tests
    config.project.services.postgres.raw = true;
    config.project.services.redis.raw = true;
    const deps = createMockDeps();
    // Keep processes alive initially
    (deps.getDescendantPids as ReturnType<typeof vi.fn>).mockResolvedValue([1000, 2000]);
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start owner
    const p = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(mgr.getStatus("postgres").state).toBe("ready");

    // Crash monitor polls every 2s — simulate container still running
    await vi.advanceTimersByTimeAsync(2500);

    // Now simulate container crash
    dockerSpy.mockResolvedValue({ state: "exited", health: "", ports: [], ids: [] });
    await vi.advanceTimersByTimeAsync(2500);

    // Should transition to error (no restart config)
    expect(mgr.getStatus("postgres").state).toBe("error");
    expect(mgr.getStatus("postgres").lastError).toBe("Process exited unexpectedly");
  });

  it("crash monitor restarts combined service on crash with restart config", async () => {
    const config = makeConfig({
      postgres: {
        docker: { service: "postgres" },
        restart: { maxRetries: 2, backoff: 100 },
        raw: true,
        _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: true },
      },
      redis: {
        docker: { service: "redis" },
        raw: true,
        _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: false },
      },
    });
    const deps = createMockDeps();
    (deps.getDescendantPids as ReturnType<typeof vi.fn>).mockResolvedValue([1000, 2000]);
    const paneMap = { "@tui": "%tui", postgres: "%infra", redis: "%infra" };

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start owner
    const p = mgr.startService("postgres");
    await vi.advanceTimersByTimeAsync(500);
    await p;

    // Simulate crash — container exits
    dockerSpy.mockResolvedValue({ state: "exited", health: "", ports: [], ids: [] });
    await vi.advanceTimersByTimeAsync(2500);

    // Should have detected crash and retried
    expect(mgr.getStatus("postgres").retryCount).toBe(1);

    // Restore container and advance to let restart complete
    dockerSpy.mockResolvedValue({ state: "running", health: "", ports: [5432], ids: [] });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mgr.getStatus("postgres").state).toBe("ready");
  });
});

// =============================================================================
// Unavailable services
// =============================================================================

describe("unavailable services", () => {
  it("constructor initializes unavailable statuses from config.unavailableServices", () => {
    const config = makeConfig({ api: { start: "start-api" } });
    config.unavailableServices = new Map([
      ["db", { name: "db", reason: "binary 'rainfrog' not found" }],
      ["tool", { name: "tool", reason: "availability check returned false" }],
    ]);
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const dbStatus = mgr.getStatus("db");
    expect(dbStatus.state).toBe("unavailable");
    expect(dbStatus.ports).toEqual([]);

    const toolStatus = mgr.getStatus("tool");
    expect(toolStatus.state).toBe("unavailable");

    // Available service still initialized normally
    expect(mgr.getStatus("api").state).toBe("stopped");
  });

  it("getAllStatuses includes unavailable services", () => {
    const config = makeConfig({ api: { start: "start-api" } });
    config.unavailableServices = new Map([
      ["db", { name: "db", reason: "binary 'rainfrog' not found" }],
    ]);
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const all = mgr.getAllStatuses();
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.name === "db")?.state).toBe("unavailable");
    expect(all.find((s) => s.name === "api")?.state).toBe("stopped");
  });

  it("stopAll skips unavailable services", async () => {
    const config = makeConfig({ api: { start: "start-api" } });
    config.unavailableServices = new Map([
      ["db", { name: "db", reason: "binary 'rainfrog' not found" }],
    ]);
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // StopAll should complete without trying to stop unavailable services
    await mgr.stopAll();

    // Unavailable service state should remain unchanged
    expect(mgr.getStatus("db").state).toBe("unavailable");
  });

  it("updateWindowTitle excludes unavailable from counts", async () => {
    const config = makeConfig({
      api: { start: "start-api", ready: { port: 3000 } },
    });
    config.unavailableServices = new Map([
      ["db", { name: "db", reason: "binary 'rainfrog' not found" }],
    ]);
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start api service to trigger title update
    deps.panePid = vi.fn(async () => 1000);
    deps.getDescendantPids = vi.fn(async () => [1000, 1100]);
    deps.detectPorts = vi.fn(async () => [3000]);
    await mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);

    // Verify renameWindow was called and the title does NOT contain "unavailable"
    const renameCalls = vi.mocked(deps.renameWindow).mock.calls;
    if (renameCalls.length > 0) {
      const lastTitle = String(renameCalls.at(-1)?.[1]);
      expect(lastTitle).not.toContain("unavailable");
    }
  });
});

// =============================================================================
// Detached services (E4)
// =============================================================================

class FakeDetachedChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly pid: number;

  public constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function makeDetachedSpawn(
  children: FakeDetachedChild[],
  basePid = 7000,
): {
  spawn: ServiceManagerDeps["detachedSpawn"];
  args: { file: string; args: string[] }[];
} {
  const args: { file: string; args: string[] }[] = [];
  let pid = basePid;
  const spawn = ((file: string, argv: string[]) => {
    const child = new FakeDetachedChild(pid);
    pid += 1;
    children.push(child);
    args.push({ file, args: argv });
    return child;
  }) as unknown as ServiceManagerDeps["detachedSpawn"];
  return { spawn, args };
}

describe("detached services (E4)", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  it("starts a detached service with no pane: spawns sh -c and goes ready", async () => {
    const config = makeConfig({ worker: { start: "node w.js", detached: true } });
    const paneMap = makePaneMap([]); // Worker has NO pane entry
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    const { spawn, args } = makeDetachedSpawn(children);
    deps.detachedSpawn = spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([4000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    await mgr.startService("worker");

    const status = mgr.getStatus("worker");
    expect(status.state).toBe("ready");
    expect(status.isDetached).toBe(true);
    // The real child pid is surfaced on the status (was always undefined).
    expect(status.pid).toBe(7000);
    expect(status.ports).toEqual([4000]);
    expect(args[0]).toEqual({ file: "sh", args: ["-c", "node w.js"] });
    // Detached port detection is PID-based, not pane-based.
    expect(deps.detectPortsForPid).toHaveBeenCalledWith(7000);
    expect(deps.recordDetached).toBeUndefined(); // Optional dep not wired in this mock
  });

  it("emits logLines as the child streams output", async () => {
    const config = makeConfig({ worker: { start: "node w.js", detached: true } });
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    deps.detachedSpawn = makeDetachedSpawn(children).spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([]);

    const mgr = new ServiceManager(config, makePaneMap([]), deps, "test-session");
    const seen: [string, string[]][] = [];
    mgr.on("logLines", (name: string, lines: string[]) => {
      seen.push([name, lines]);
    });

    await mgr.startService("worker");
    children[0].stdout.emit("data", Buffer.from("hello\nworld\n"));
    expect(seen).toContainEqual(["worker", ["hello", "world"]]);
  });

  it("stops a detached service by signalling its process group", async () => {
    const config = makeConfig({ worker: { start: "node w.js", detached: true } });
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    deps.detachedSpawn = makeDetachedSpawn(children).spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([]);

    const mgr = new ServiceManager(config, makePaneMap([]), deps, "test-session");
    await mgr.startService("worker");

    const kill = vi.mocked(process.kill);
    const stopPromise = mgr.stopService("worker");
    // Let the per-service lock run stopServiceInternal → runner.stop (SIGTERM).
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(-7000, "SIGTERM");

    children[0].emit("exit", null, "SIGTERM");
    await stopPromise;
    expect(mgr.getStatus("worker").state).toBe("stopped");
  });

  it("restarts a detached service after a crash exit (generation-checked)", async () => {
    const config = makeConfig({
      worker: { start: "node w.js", detached: true, restart: { maxRetries: 3, backoff: 1000 } },
    });
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    deps.detachedSpawn = makeDetachedSpawn(children).spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([]);

    const mgr = new ServiceManager(config, makePaneMap([]), deps, "test-session");
    await mgr.startService("worker");
    expect(mgr.getStatus("worker").state).toBe("ready");

    // Child crashes unexpectedly.
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1500);

    expect(children.length).toBe(2); // Respawned
    expect(mgr.getStatus("worker").state).toBe("ready");
    expect(mgr.getStatus("worker").retryCount).toBe(1);
  });

  it("a detached child exit during startup fails fast (no ready-timeout wait)", async () => {
    const config = makeConfig({
      worker: { start: "node w.js", detached: true, ready: { output: /never/u } },
    });
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    deps.detachedSpawn = makeDetachedSpawn(children).spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([]);

    const mgr = new ServiceManager(config, makePaneMap([]), deps, "test-session");
    const startPromise = mgr.startService("worker");
    // Let the lock run startServiceInternal far enough to spawn the child.
    await vi.advanceTimersByTimeAsync(1);
    // Child dies before the ready output ever appears.
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(600);
    await startPromise;

    const status = mgr.getStatus("worker");
    expect(status.state).toBe("error");
    expect(status.lastError).toBe("Process exited before becoming ready");
  });

  it("startAll includes detached services alongside pane services", async () => {
    const config = makeConfig({
      pane: { start: "node p.js" },
      worker: { start: "node w.js", detached: true },
    });
    const paneMap = makePaneMap(["pane"]); // Only the pane service gets a pane
    const deps = createMockDeps();
    const children: FakeDetachedChild[] = [];
    deps.detachedSpawn = makeDetachedSpawn(children).spawn;
    deps.detectPortsForPid = vi.fn().mockResolvedValue([]);
    deps.detectPorts = vi.fn().mockResolvedValue([]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    await mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mgr.getStatus("worker").state).toBe("ready");
    expect(children.length).toBe(1);
  });
});

// =============================================================================
// Lazy-pane lifecycle wiring (P04-T04)
// =============================================================================

describe("lazy-pane lifecycle", () => {
  function lazyConfig(services: Record<string, ServiceConfig>, lazy: string[]): ResolvedConfig {
    const config = makeConfig(services);
    for (const name of lazy) {
      config.lazyPaneByService.set(name, true);
    }
    return config;
  }

  it("startService inserts the pane BEFORE the per-service lock body runs", async () => {
    // The body of `startServiceInternal` would throw `Unknown service` if it
    // Ran first (no `paneMap[name]`). The wrapper inserts the pane first,
    // Populating paneMap; then the locked body succeeds.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" }; // No worker pane.
    const deps = createMockDeps();
    deps.reflowInsert = vi.fn(async (name: string) => {
      paneMap[name] = "%worker";
    });
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("worker");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(deps.reflowInsert).toHaveBeenCalledWith("worker");
    expect(deps.reflowInsert).toHaveBeenCalledTimes(1);
    // The service actually started — proves insert ran first (otherwise
    // StartServiceInternal would have thrown `Unknown service`).
    expect(mgr.getStatus("worker").state).toBe("ready");
    expect(paneMap.worker).toBe("%worker");
  });

  it("startService is NOT a reflowInsert when service already has a pane", async () => {
    // Lazy + autostart-paned (boot-skip would have left a pane in place).
    const config = lazyConfig({ api: { start: "npm dev" } }, ["api"]);
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(deps.reflowInsert).not.toHaveBeenCalled();
    expect(mgr.getStatus("api").state).toBe("ready");
  });

  it("startService is NOT a reflowInsert for non-lazy services (regression)", async () => {
    const config = makeConfig({ api: { start: "npm dev" } }); // No lazyPane entry.
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const startPromise = mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(deps.reflowInsert).not.toHaveBeenCalled();
    expect(deps.reflowRemove).not.toHaveBeenCalled();
  });

  it("startService PROPAGATES reflowInsert failure WITHOUT mutating service state", async () => {
    // Lock-ordering invariant: the reflow runs OUTSIDE `withServiceLock`. If
    // It throws, the lock-guarded body never ran — no state transition, no
    // `starting` event, no pane mutation.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" };
    const deps = createMockDeps();
    deps.reflowInsert = vi.fn().mockRejectedValue(new Error("forced split failure"));
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    const stateEvents: string[] = [];
    mgr.on("stateChange", (_, status: ServiceStatus) => {
      stateEvents.push(status.state);
    });

    await expect(mgr.startService("worker")).rejects.toThrow(/forced split failure/);
    expect(paneMap.worker).toBeUndefined();
    // The lock-guarded body would have transitioned to `starting` on entry.
    // It didn't run, so no transitions fired.
    expect(stateEvents).toEqual([]);
    expect(mgr.getStatus("worker").state).toBe("stopped");
  });

  it("stopService calls reflowRemove AFTER the per-service lock releases (lazy + has pane)", async () => {
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap = makePaneMap(["worker"]);
    const deps = createMockDeps();
    // Resolve immediately; track call order against state-change events.
    const events: string[] = [];
    deps.reflowRemove = vi.fn(async (name: string) => {
      events.push(`reflowRemove(${name})`);
      // Simulate the session-side delete that LayoutReflow.removePane does.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- mirroring the real removePane behavior
      delete paneMap[name];
    });
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    mgr.on("stateChange", (_, status: ServiceStatus) => {
      events.push(`state:${status.state}`);
    });

    await mgr.startService("worker");
    await vi.advanceTimersByTimeAsync(2000);

    events.length = 0;
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]); // Process exits.
    await mgr.stopService("worker");
    await vi.advanceTimersByTimeAsync(2000);

    // The lock-guarded body fires the stop transitions; the reflowRemove
    // Fires AFTER (the last entry in `events` is the reflow).
    expect(events).toContain("state:stopping");
    expect(events).toContain("state:stopped");
    expect(events.at(-1)).toBe("reflowRemove(worker)");
    expect(paneMap.worker).toBeUndefined();
  });

  it("stopService skips reflowRemove for a NON-lazy service (regression)", async () => {
    const config = makeConfig({ api: { start: "npm dev" } });
    const paneMap = makePaneMap(["api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);

    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);
    await mgr.stopService("api");
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.reflowRemove).not.toHaveBeenCalled();
    // Non-lazy: pane survives stop.
    expect(paneMap.api).toBe("%api");
  });

  it("stopService skips reflowRemove for a lazy service with no pane", async () => {
    // Never-started lazy service: stopService is a no-op AND must not call
    // ReflowRemove (no pane to remove).
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" }; // No worker pane.
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // StopService throws `Unknown service` when pane-less and non-detached —
    // That's the existing contract; what matters is reflowRemove isn't called.
    await expect(mgr.stopService("worker")).rejects.toThrow(/Unknown service/);
    expect(deps.reflowRemove).not.toHaveBeenCalled();
  });

  it("crash does NOT call reflowRemove (pane kept across the restart loop)", async () => {
    const config = lazyConfig(
      {
        worker: {
          start: "node w.js",
          restart: { maxRetries: 1, backoff: 1 },
        },
      },
      ["worker"],
    );
    const paneMap = makePaneMap(["worker"]);
    const deps = createMockDeps();
    // Start: process spawns; then immediately exits → handleCrash triggers.
    deps.getDescendantPids = vi.fn().mockResolvedValueOnce([1000, 2000]).mockResolvedValue([1000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await mgr.startService("worker");
    // Let monitor tick + crash handler run.
    await vi.advanceTimersByTimeAsync(5000);

    expect(deps.reflowRemove).not.toHaveBeenCalled();
    // Pane survives the crash for the restart loop.
    expect(paneMap.worker).toBe("%worker");
  });

  it("stopAll skips reflowRemove for every lazy service (shuttingDown guard, deadlock fix)", async () => {
    // The deadlock that would fire without the guard:
    //   `Session.reload`/`destroy` hold `withOpLock` → `manager.stopAll()` →
    //   `stopAllServices` → per-service `stopService` → `reflowRemove` →
    //   `Session.reflowRemove` → `withOpLock` (NOT re-entrant) → chains AFTER
    //   The outer reload `fn` that is awaiting `stopAll` → permanent hang.
    // The guard short-circuits `reflowRemove` while `this.shuttingDown` is
    // True — which `runStopAll` sets BEFORE iterating, so EVERY stopService
    // Called from within stopAll sees it. _reload step 4 (session.ts:434-440)
    // Kill-panes anyway, so this is also redundant in the reload path.
    const config = lazyConfig(
      {
        worker: { start: "node w.js" },
        api: { start: "npm dev" },
      },
      ["worker"], // Only `worker` is lazy.
    );
    const paneMap = makePaneMap(["worker", "api"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Get both services to `ready` first.
    await mgr.startService("worker");
    await mgr.startService("api");
    await vi.advanceTimersByTimeAsync(2000);
    vi.mocked(deps.reflowInsert).mockClear();
    vi.mocked(deps.reflowRemove).mockClear();

    // StopAll: the shuttingDown guard MUST suppress reflowRemove on `worker`.
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]); // Process exits.
    await mgr.stopAll();
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.reflowRemove).not.toHaveBeenCalled();
    // Sanity: non-shutdown stopService still fires reflowRemove for lazy.
    // (We can't easily verify post-stopAll because shuttingDown reset to false
    // After stopAllServices returned — fire a manual stopService now: the
    // Service is already stopped so it'll be a noop, and reflowRemove won't
    // Fire because paneMap mutations from stopAll left the world unchanged
    // For non-lazy services either. The point of THIS test is the negative
    // Assertion above.)
  });

  it("startService skips reflowInsert when shuttingDown (re-entrance guard, deadlock fix)", async () => {
    // Symmetric to the stopService shuttingDown guard. The deadlock the guard
    // Closes:
    //   `reload` holds withOpLock → `manager.stopAll()` → `stopService(svc1)`
    //   → `onStop` hook → `lib.startService(svc2)` → wrapper-level
    //   `deps.reflowInsert(svc2)` → `Session.reflowInsert` → withOpLock
    //   (not re-entrant) → chains AFTER outer reload fn → permanent hang.
    // `lib.startService`/`restartService` are exposed to hooks
    // (config/builder.ts:49-53), so this is a real reachable footgun. The
    // Guard short-circuits reflowInsert when `shuttingDown` is true —
    // RunStopAll sets it BEFORE iterating, so every hook-driven start during
    // Reload sees it.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" };
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    // Simulate the shutdown phase (what runStopAll sets at line 496).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- toggling the private flag for the deadlock-guard test
    (mgr as any).shuttingDown = true;

    // StartService on a lazy pane-less service during shutdown: reflowInsert
    // Is skipped. `startServiceInternal` will throw `Unknown service` since
    // PaneMap[worker] is absent — the rejection is the existing contract,
    // What matters is reflowInsert isn't called (no withOpLock re-entrance).
    await expect(mgr.startService("worker")).rejects.toThrow(/Unknown service/);
    expect(deps.reflowInsert).not.toHaveBeenCalled();
  });

  it("restartService skips reflowInsert when shuttingDown (re-entrance guard)", async () => {
    // Companion to the startService guard test. lib.restartService is also
    // Hook-reachable (config/builder.ts:49-53), so the wrapper carries the
    // Same shuttingDown short-circuit.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" };
    const deps = createMockDeps();
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- toggling the private flag for the deadlock-guard test
    (mgr as any).shuttingDown = true;

    await expect(mgr.restartService("worker")).rejects.toBeDefined();
    expect(deps.reflowInsert).not.toHaveBeenCalled();
  });

  it("manual stopService (no shutdown) still calls reflowRemove (positive control)", async () => {
    // Companion to the shuttingDown guard test: confirms the guard ONLY fires
    // During shutdown, not on the manual path.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap = makePaneMap(["worker"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await mgr.startService("worker");
    await vi.advanceTimersByTimeAsync(2000);
    vi.mocked(deps.reflowRemove).mockClear();

    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);
    await mgr.stopService("worker");
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.reflowRemove).toHaveBeenCalledWith("worker");
  });

  it("restartService on a STOPPED pane-less lazy service CALLS reflowInsert (re-creates pane)", async () => {
    // Symmetric to startService for the lazy pane-less case: a stopped lazy
    // Service has no paneMap entry, so restartServiceInternal's internal
    // `startServiceInternal` would throw `Unknown service`. The wrapper-level
    // ReflowInsert (mirroring `startService`) populates paneMap before the
    // Locked body runs. Op-lock-outermost is preserved (call OUTSIDE
    // WithServiceLock). The running-restart case (next test) does NOT fire
    // ReflowInsert because `paneMap[name]` already exists.
    const config = lazyConfig({ worker: { start: "node w.js" } }, ["worker"]);
    const paneMap: Record<string, string> = { "@tui": "%tui" }; // Worker stopped + pane-less.
    const deps = createMockDeps();
    deps.reflowInsert = vi.fn(async (name: string) => {
      paneMap[name] = "%worker";
    });
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // RestartService on a stopped pane-less lazy: would throw `Unknown service`
    // Without the wrapper reflowInsert. Drive it forward and assert reflowInsert ran.
    void mgr.restartService("worker");
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.reflowInsert).toHaveBeenCalledWith("worker");
    expect(paneMap.worker).toBe("%worker");
  });

  it("restartService never calls the reflow hooks (pane kept by design)", async () => {
    // RestartServiceInternal re-sends the start command to the existing pane;
    // It never touches reflowInsert or reflowRemove. The public wrapper
    // `restartService` (manager.ts:1070) only acquires `withServiceLock`,
    // Bypassing the lazy-lifecycle wiring on the start/stop wrappers. This
    // Test pins that bypass by attempting a restart and asserting the hooks
    // Stayed dormant — we don't drive it to ready (that path is exercised
    // Elsewhere), only that the hooks aren't called along the way.
    const config = lazyConfig({ worker: { start: "node w.js", raw: true } }, ["worker"]);
    const paneMap = makePaneMap(["worker"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);
    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    await mgr.startService("worker");
    await vi.advanceTimersByTimeAsync(2000);
    vi.mocked(deps.reflowInsert).mockClear();
    vi.mocked(deps.reflowRemove).mockClear();

    // Don't await — the restart loop polls indefinitely under fake timers
    // Without a fully-faked child process. We only assert the hooks stayed
    // Dormant during the call dispatch.
    void mgr.restartService("worker");
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.reflowInsert).not.toHaveBeenCalled();
    expect(deps.reflowRemove).not.toHaveBeenCalled();
    expect(paneMap.worker).toBe("%worker");
  });
});
