import { createConnection } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedConfig, ServiceConfig } from "../../../src/config/types.js";
import { ProcessRunner } from "../../../src/lib/backend/runtime/process-runner.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  RuntimeDriver,
} from "../../../src/lib/backend/types.js";
import { shellEscape } from "../../../src/lib/service/env.js";
import { ServiceManager } from "../../../src/lib/service/manager.js";
import type { ServiceManagerDeps } from "../../../src/lib/service/manager.js";

function deferred<T>() {
  let complete!: (value: T | PromiseLike<T>) => void;
  let fail!: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: complete, reject: fail };
}

function runtimeHarness() {
  const listeners = new Set<(event: ExecutionEvent) => void>();
  const handles: ExecutionHandle[] = [];
  const driver: RuntimeDriver = {
    start: vi.fn<RuntimeDriver["start"]>(async (spec) => {
      const handle = {
        id: `opaque-${spec.generation}`,
        unitId: spec.unitId,
        generation: spec.generation,
      };
      handles.push(handle);
      return handle;
    }),
    stop: vi.fn<RuntimeDriver["stop"]>().mockResolvedValue(),
    isRunning: vi.fn<RuntimeDriver["isRunning"]>().mockResolvedValue(true),
    getPid: vi.fn<RuntimeDriver["getPid"]>().mockResolvedValue(undefined),
    readOutput: vi.fn<RuntimeDriver["readOutput"]>().mockResolvedValue([]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (kind: "leaderExit" | "exit", generation = 1, cleanupError?: string) => {
    const details = { unitId: "svc", generation, code: 1, signal: null };
    for (const listener of listeners) {
      listener(kind === "exit" ? { ...details, kind, cleanupError } : { ...details, kind });
    }
  };
  return { driver, handles, emit };
}

const managers: ServiceManager[] = [];
function makeManager(runtime: RuntimeDriver, service: ServiceConfig = {}) {
  const deps: ServiceManagerDeps = {
    runtime: () => runtime,
    inspectPorts: async () => [],
    sendKeys: vi.fn(),
    sendCtrlC: vi.fn(),
    panePid: vi.fn(),
    detectPorts: vi.fn(),
    capturePane: vi.fn(),
    getDescendantPids: vi.fn(),
    renameWindow: vi.fn().mockResolvedValue(undefined),
    getWindowName: async () => "original",
    getWindowOption: async () => "on",
    setWindowOption: vi.fn().mockResolvedValue(undefined),
    displayPopup: vi.fn(),
    exec: vi.fn(),
    preflightPorts: async () => null,
    storeExecInfo: vi.fn(),
    sessionId: "lifecycle",
    zapsCommand: "unused",
    reflowInsert: vi.fn(),
    reflowRemove: vi.fn(),
  };
  const config: ResolvedConfig = {
    project: { name: "lifecycle", services: { svc: { start: "serve", url: false, ...service } } },
    configPath: "/unused",
    projectDir: process.cwd(),
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
  const manager = new ServiceManager(config, {}, deps, "lifecycle");
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.abortStartAll();
    await manager.stopAll();
  }
  vi.useRealTimers();
});

async function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe("owned service lifecycle", () => {
  it("releases a real listening port before publishing failed readiness", async () => {
    const runner = new ProcessRunner({ onLines: vi.fn(), onExit: vi.fn() });
    let handle: ExecutionHandle | undefined;
    const driver: RuntimeDriver = {
      start: async (spec) => {
        handle = runner.spawnOwned(spec);
        return handle;
      },
      stop: async (execution) => runner.stop(execution),
      getPid: async (execution) => runner.getPid(execution),
      isRunning: async (execution) => runner.isRunning(execution),
      readOutput: async (execution, tail) => runner.readOutput(execution, tail),
      subscribe: (listener) => runner.subscribe(listener),
    };
    let port = 0;
    let terminalPortCheck: Promise<boolean> | undefined;
    const payload =
      'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>console.log("PORT "+s.address().port))';
    const manager = makeManager(driver, {
      start: `${shellEscape(process.execPath)} -e ${shellEscape(payload)}`,
      ready: async () => {
        const match = /PORT (?<port>\d+)/u.exec(
          handle ? runner.readOutput(handle, 20).join("\n") : "",
        );
        if (!match?.groups?.port) {
          return false;
        }
        port = Number(match.groups.port);
        expect(await acceptsConnection(port)).toBe(true);
        throw new Error("fixture readiness rejected");
      },
    });
    manager.on("stateChange", (_name, status) => {
      if (status.state === "error") {
        terminalPortCheck = acceptsConnection(port);
      }
    });
    try {
      await manager.startService("svc");
      expect(port).toBeGreaterThan(0);
      expect(manager.getStatus("svc")).toMatchObject({
        state: "error",
        lastError: "fixture readiness rejected",
      });
      expect(await terminalPortCheck).toBe(false);
      expect(await manager.stopService("svc")).toEqual({ noop: true });
    } finally {
      await runner.dispose();
    }
  });

  it.each(["error", "stopped"] as const)(
    "cleans owned handles despite %s row and makes repeated stop a no-op",
    async (state) => {
      const runtime = runtimeHarness();
      const manager = makeManager(runtime.driver);
      await manager.startService("svc");
      manager.getStatus("svc").state = state;
      expect(await manager.stopService("svc")).toEqual({ noop: false });
      expect(runtime.driver.stop).toHaveBeenCalledWith(runtime.handles[0]);
      expect(await manager.stopService("svc")).toEqual({ noop: true });
      expect(runtime.driver.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("retains failed cleanup, blocks replacement and retries cleanup on bulk stop", async () => {
    const runtime = runtimeHarness();
    const manager = makeManager(runtime.driver);
    await manager.startService("svc");
    vi.mocked(runtime.driver.stop).mockRejectedValue(new Error("still owned"));
    await expect(manager.restartService("svc")).rejects.toThrow("still owned");
    expect(manager.getStatus("svc")).toMatchObject({
      state: "error",
      lastError: expect.stringContaining("still owned"),
    });
    await expect(manager.startService("svc")).rejects.toThrow("still owned");
    await expect(manager.stopAll()).rejects.toThrow("Service cleanup incomplete");
    expect(runtime.driver.start).toHaveBeenCalledTimes(1);
    vi.mocked(runtime.driver.stop).mockResolvedValue();
    await manager.restartService("svc");
    expect(runtime.driver.start).toHaveBeenCalledTimes(2);
    expect(runtime.handles[1]?.generation).toBe(2);
  });

  it("waits for cleanup/drain before error and before restarting a failed ready service", async () => {
    const runtime = runtimeHarness();
    const cleanup = deferred<void>();
    vi.mocked(runtime.driver.stop).mockReturnValue(cleanup.promise);
    const ready = vi.fn().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(true);
    const manager = makeManager(runtime.driver, { ready });
    const start = manager.startService("svc");
    await vi.waitFor(() => expect(runtime.driver.stop).toHaveBeenCalledTimes(1));
    expect(manager.getStatus("svc").state).toBe("starting");
    const restart = manager.restartService("svc");
    expect(runtime.driver.start).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await start;
    await restart;
    expect(runtime.driver.start).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("svc").state).toBe("ready");
  });

  it("cancels readiness at leader exit, waits for final exit and ignores stale callbacks", async () => {
    vi.useFakeTimers();
    const runtime = runtimeHarness();
    const ready = deferred<boolean>();
    const onReady = vi.fn();
    const manager = makeManager(runtime.driver, {
      ready: async () => ready.promise,
      onReady,
      restart: { backoff: 10 },
    });
    const start = manager.startService("svc");
    await vi.advanceTimersByTimeAsync(0);
    runtime.emit("leaderExit");
    expect(manager.getStatus("svc").state).toBe("starting");
    runtime.emit("exit");
    expect(manager.getStatus("svc")).toMatchObject({ state: "error", retryCount: 0 });
    ready.resolve(true);
    await start;
    expect(onReady).not.toHaveBeenCalled();
    await manager.restartService("svc");
    runtime.emit("exit", 1);
    runtime.emit("leaderExit", 1);
    expect(manager.getStatus("svc").state).toBe("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("classifies final exit once; retries only after drain, never during requested stop", async () => {
    vi.useFakeTimers();
    const runtime = runtimeHarness();
    const manager = makeManager(runtime.driver, { restart: { backoff: 10 } });
    await manager.startService("svc");
    runtime.emit("leaderExit");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.driver.start).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("svc").retryCount).toBe(0);
    runtime.emit("exit");
    runtime.emit("exit");
    expect(manager.getStatus("svc").retryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(runtime.driver.start).toHaveBeenCalledTimes(2);
    vi.mocked(runtime.driver.stop).mockImplementation(async () => {
      runtime.emit("leaderExit", 2);
      runtime.emit("exit", 2);
    });
    await manager.stopService("svc");
    await vi.advanceTimersByTimeAsync(20);
    expect(runtime.driver.start).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("svc").state).toBe("stopped");
  });

  it("retains final-exit cleanup failures and excludes them from retries", async () => {
    const runtime = runtimeHarness();
    const manager = makeManager(runtime.driver, { restart: { backoff: 1 } });
    await manager.startService("svc");
    runtime.emit("leaderExit");
    runtime.emit("exit", 1, "descendant remains");
    expect(manager.getStatus("svc")).toMatchObject({
      state: "error",
      retryCount: 0,
      lastError: expect.stringContaining("descendant remains"),
    });
    await manager.stopService("svc");
    expect(runtime.driver.stop).toHaveBeenCalledWith(runtime.handles[0]);
  });

  it("does not let a stale ready hook failure change a replacement", async () => {
    const runtime = runtimeHarness();
    const hook = deferred<void>();
    const onReady = vi.fn().mockReturnValueOnce(hook.promise).mockResolvedValue(undefined);
    const manager = makeManager(runtime.driver, { onReady });
    const first = manager.startService("svc");
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    runtime.emit("leaderExit");
    runtime.emit("exit");
    hook.reject(new Error("old hook failed"));
    await first;
    await manager.restartService("svc");
    expect(manager.getStatus("svc")).toMatchObject({ state: "ready" });
    expect(manager.getStatus("svc").lastError).not.toContain("old hook failed");
  });

  it("runs onStop only after cleanup and never executes the custom stop field", async () => {
    const runtime = runtimeHarness();
    const cleanup = deferred<void>();
    const customStop = vi.fn(() => "forbidden");
    const onStop = vi.fn();
    const manager = makeManager(runtime.driver, { stop: customStop, onStop });
    await manager.startService("svc");
    vi.mocked(runtime.driver.stop).mockReturnValue(cleanup.promise);
    const stopping = manager.stopService("svc");
    await vi.waitFor(() => expect(runtime.driver.stop).toHaveBeenCalledOnce());
    expect(onStop).not.toHaveBeenCalled();
    cleanup.resolve();
    await stopping;
    expect(onStop).toHaveBeenCalledOnce();
    expect(customStop).not.toHaveBeenCalled();
  });
});
