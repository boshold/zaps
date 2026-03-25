import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryActions, ResolvedConfig, ServiceConfig } from "../../../src/config/types.js";
import type { ServiceManagerDeps } from "../../../src/lib/service/manager.js";
import { ServiceManager, diffOutput } from "../../../src/lib/service/manager.js";
import type { ServiceStatus } from "../../../src/lib/service/types.js";

vi.mock("../../../src/lib/probe.js", () => ({
  probePort: vi.fn().mockResolvedValue(undefined),
}));

const { probePort } = (await import("../../../src/lib/probe.js")) as {
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
    storeExecInfo: vi.fn(),
    sessionId: "test-session-id",
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

  it("is idempotent — second call returns early", async () => {
    const config = makeConfig({ db: { start: "start-db" } });
    const paneMap = makePaneMap(["db"]);
    const deps = createMockDeps();
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000, 2000]);

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const startPromise = mgr.startAll();
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    // Use a slow stopService to test idempotency
    deps.getDescendantPids = vi.fn().mockResolvedValue([1000]);

    const p1 = mgr.stopAll();
    const p2 = mgr.stopAll(); // Should return early
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([p1, p2]);

    // SendCtrlC should only be called once
    expect(deps.sendCtrlC).toHaveBeenCalledTimes(1);
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
    expect(apiCall?.[1]).toBe("zaps exec-service api --session test-session-id");
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
    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%svc",
      "zaps exec-service svc --session test-session-id",
    );
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

    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%svc",
      "zaps exec-service svc --session test-session-id",
    );
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

    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%svc",
      "zaps exec-service svc --session test-session-id",
    );
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
    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%svc",
      "zaps exec-service svc --session test-session-id",
    );
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
      svc: { start: "start-svc", restart: { maxRetries: 3, backoff: 1000 } },
    });
    const paneMap = makePaneMap(["svc"]);
    const deps = createMockDeps();

    let startCount = 0;
    let crashed = false;

    deps.sendKeys = vi.fn(async () => {
      startCount += 1;
    });

    deps.getDescendantPids = vi.fn(async () => {
      // After first start, simulate crash after some time
      if (crashed) {
        return [1000]; // Only shell, no child = crashed
      }
      return [1000, 2000]; // Running
    });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");

    // Start service
    const startPromise = mgr.startService("svc");
    await vi.advanceTimersByTimeAsync(2000);
    await startPromise;

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(startCount).toBe(1);

    // Simulate crash
    crashed = true;

    // Wait for crash monitor poll (2s)
    await vi.advanceTimersByTimeAsync(2500);

    // Crash detected, state becomes restarting, then backoff (1000ms)
    // Then it restarts
    crashed = false; // Service recovers on restart
    await vi.advanceTimersByTimeAsync(2000);

    expect(startCount).toBe(2);
    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(mgr.getStatus("svc").retryCount).toBe(1);
  });

  it("transitions to error when retries exhausted", async () => {
    const config = makeConfig({
      svc: { start: "start-svc", restart: { maxRetries: 1, backoff: 100 } },
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
      svc: { start: "start-svc", restart: { maxRetries: 0 } },
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
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432] });

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
        return { state: "running", health: "healthy", ports: [5432] };
      }
      return { state: "created", health: "", ports: [] };
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
    spy.mockResolvedValue({ state: "running", health: "", ports: [] });

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
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%db",
      "zaps exec-service db --session test-session-id",
    );
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
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%db",
      "zaps exec-service db --session test-session-id",
    );

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
    spy.mockResolvedValue({ state: "running", health: "healthy", ports: [5432] });

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
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const mgr = new ServiceManager(config, paneMap, deps, "test-session");
    const promise = mgr.startService("db");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // GetContainerInfo should be called with the composeFile
    expect(spy).toHaveBeenCalledWith("postgres", "/test", "my-compose.yml");

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

    const startEvents: { taskKey: string; taskName: string }[] = [];
    mgr.on("taskStart", (taskKey: string, taskName: string) => {
      startEvents.push({ taskKey, taskName });
    });
    const events: { taskKey: string; taskName: string; result: string }[] = [];
    mgr.on("taskComplete", (taskKey: string, taskName: string, result: string) => {
      events.push({ taskKey, taskName, result });
    });

    await capturedActions.runTask("migrate");

    expect(startEvents).toEqual([{ taskKey: "migrate", taskName: "Run migrations" }]);
    expect(events).toEqual([{ taskKey: "migrate", taskName: "Run migrations", result: "success" }]);
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

    const startEvents: { taskKey: string; taskName: string }[] = [];
    mgr.on("taskStart", (taskKey: string, taskName: string) => {
      startEvents.push({ taskKey, taskName });
    });
    const events: { taskKey: string; taskName: string; result: string }[] = [];
    mgr.on("taskComplete", (taskKey: string, taskName: string, result: string) => {
      events.push({ taskKey, taskName, result });
    });

    await expect(capturedActions.runTask("broken")).rejects.toThrow("Task 'broken' failed");

    expect(startEvents).toEqual([{ taskKey: "broken", taskName: "Broken task" }]);
    expect(events).toEqual([{ taskKey: "broken", taskName: "Broken task", result: "error" }]);
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

  it("returns new lines after overlap", () => {
    expect(diffOutput(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
  });

  it("returns all current lines when no overlap found", () => {
    expect(diffOutput(["x", "y"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty array when captures are identical", () => {
    expect(diffOutput(["a", "b"], ["a", "b"])).toEqual([]);
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
    spy.mockResolvedValue({ state: "running", health: "", ports: [5432] });

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
    const storedInfo = (deps.storeExecInfo as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedInfo?.[1].command).toContain("postgres");
    expect(storedInfo?.[1].command).toContain("redis");
    expect(deps.sendKeys).toHaveBeenCalledWith(
      "%infra",
      "zaps exec-service postgres --session test-session-id",
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

  it("crash monitor checks docker container status for combined services", async () => {
    const config = makeCombinedConfig();
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
    dockerSpy.mockResolvedValue({ state: "exited", health: "", ports: [] });
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
        _combined: { group: "infra", allServices: ["postgres", "redis"], isOwner: true },
      },
      redis: {
        docker: { service: "redis" },
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
    dockerSpy.mockResolvedValue({ state: "exited", health: "", ports: [] });
    await vi.advanceTimersByTimeAsync(2500);

    // Should have detected crash and retried
    expect(mgr.getStatus("postgres").retryCount).toBe(1);

    // Restore container and advance to let restart complete
    dockerSpy.mockResolvedValue({ state: "running", health: "", ports: [5432] });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mgr.getStatus("postgres").state).toBe("ready");
  });
});
