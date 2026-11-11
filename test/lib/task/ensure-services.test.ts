import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceConfig } from "../../../src/config/types.js";
import type {
  ServiceActionResult,
  ServiceState,
  ServiceStatus,
} from "../../../src/lib/service/types.js";
import {
  ServiceStartFailedError,
  ServiceUnavailableError,
  ServicesNotRunningError,
  TASK_SERVICE_HEARTBEAT_MS,
  ensureTaskServices,
  planTaskServices,
  summarizePlan,
} from "../../../src/lib/task/ensure-services.js";
import type {
  TaskServiceEvent,
  TaskServicePlanEntry,
} from "../../../src/lib/task/ensure-services.js";

function status(name: string, state: ServiceState, lastError?: string): ServiceStatus {
  return { name, state, ports: [], retryCount: 0, lastError };
}

type StartBehavior = (name: string, mgr: FakeManager) => Promise<ServiceActionResult>;

async function startAndBecomeReady(name: string, mgr: FakeManager): Promise<ServiceActionResult> {
  mgr.set(name, "starting");
  await Promise.resolve();
  mgr.set(name, "ready");
  return { noop: false };
}

class FakeManager extends EventEmitter {
  public readonly statuses = new Map<string, ServiceStatus>();
  public readonly startCalls: string[] = [];
  public behavior: StartBehavior = startAndBecomeReady;

  public constructor(states: Record<string, ServiceState>) {
    super();
    for (const [name, state] of Object.entries(states)) {
      this.statuses.set(name, status(name, state));
    }
  }

  public set(name: string, state: ServiceState, lastError?: string): void {
    const s = status(name, state, lastError);
    this.statuses.set(name, s);
    this.emit("stateChange", name, s);
  }

  public async startService(name: string): Promise<ServiceActionResult> {
    this.startCalls.push(name);
    return this.behavior(name, this);
  }

  public getAllStatuses(): ServiceStatus[] {
    return [...this.statuses.values()];
  }
}

function req(services: string[], autoStartServices: string[] = []) {
  return { services, autoStartServices };
}

function statusesOf(states: Record<string, ServiceState>): ServiceStatus[] {
  return Object.entries(states).map(([n, s]) => status(n, s));
}

function entry(
  name: string,
  action: TaskServicePlanEntry["action"],
  extra: Partial<TaskServicePlanEntry> = {},
): TaskServicePlanEntry {
  const states: Record<TaskServicePlanEntry["action"], ServiceState> = {
    ok: "ready",
    wait: "starting",
    blocked: "unavailable",
    start: "stopped",
  };
  const state = states[action];
  return { name, state, action, required: true, startable: false, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("planTaskServices", () => {
  it.each<[ServiceState, TaskServicePlanEntry["action"]]>([
    ["ready", "ok"],
    ["starting", "wait"],
    ["restarting", "wait"],
    ["stopped", "start"],
    ["error", "start"],
    ["stopping", "start"],
    ["unavailable", "blocked"],
  ])("maps state %s to action %s", (state, action) => {
    const plan = planTaskServices(req(["db"]), statusesOf({ db: state }), { db: {} });
    expect(plan).toEqual([
      expect.objectContaining({ name: "db", state, action, required: true, startable: false }),
    ]);
  });

  it("marks startable from autoStartServices", () => {
    const plan = planTaskServices(
      req(["db", "api"], ["db"]),
      statusesOf({ db: "stopped", api: "stopped" }),
      { db: {}, api: {} },
    );
    expect(plan.map((e) => [e.name, e.startable])).toEqual([
      ["db", true],
      ["api", false],
    ]);
  });

  it("adds non-ready transitive deps of start entries in dependency order, inheriting startable", () => {
    const plan = planTaskServices(
      req(["api"], ["api"]),
      statusesOf({ api: "stopped", cache: "stopped", db: "error", net: "ready" }),
      {
        api: { dependsOn: ["cache"] },
        cache: { dependsOn: ["db", "net"] },
        db: {},
        net: {},
      },
    );
    expect(plan).toEqual([
      { name: "db", state: "error", action: "start", required: false, startable: true },
      { name: "cache", state: "stopped", action: "start", required: false, startable: true },
      { name: "api", state: "stopped", action: "start", required: true, startable: true },
    ]);
  });

  it("includes non-autostart deps (flags.start: false)", () => {
    const configs: Record<string, ServiceConfig> = {
      api: { start: "api", dependsOn: ["db"] },
      db: { start: "db", flags: { start: false } },
    };
    const plan = planTaskServices(
      req(["api"]),
      statusesOf({ api: "stopped", db: "stopped" }),
      configs,
    );
    expect(plan.map((e) => e.name)).toEqual(["db", "api"]);
  });

  it("does not add deps of ok or wait entries", () => {
    const plan = planTaskServices(
      req(["api", "web"]),
      statusesOf({ api: "ready", web: "starting", db: "stopped" }),
      { api: { dependsOn: ["db"] }, web: { dependsOn: ["db"] }, db: {} },
    );
    expect(plan.map((e) => e.name)).toEqual(["api", "web"]);
  });

  it("a shared dep becomes startable if any startable entry needs it", () => {
    const plan = planTaskServices(
      req(["a", "b"], ["b"]),
      statusesOf({ a: "stopped", b: "stopped", db: "stopped" }),
      { a: { dependsOn: ["db"] }, b: { dependsOn: ["db"] }, db: {} },
    );
    expect(plan.find((e) => e.name === "db")).toMatchObject({ required: false, startable: true });
  });

  it("required dep keeps required: true and gains inherited startable", () => {
    const plan = planTaskServices(
      req(["db", "api"], ["api"]),
      statusesOf({ db: "stopped", api: "stopped" }),
      { api: { dependsOn: ["db"] }, db: {} },
    );
    expect(plan[0]).toMatchObject({ name: "db", required: true, startable: true });
  });

  it("blocks unavailable services with the reason", () => {
    const plan = planTaskServices(
      req(["db"]),
      statusesOf({ db: "unavailable" }),
      {},
      new Map([["db", { reason: "binary 'pg' not found" }]]),
    );
    expect(plan[0]).toMatchObject({ action: "blocked", reason: "binary 'pg' not found" });
  });

  it("blocks a service with neither status nor config, with a fallback reason", () => {
    const plan = planTaskServices(req(["redis"]), [], {});
    expect(plan[0]).toEqual({
      name: "redis",
      state: "unavailable",
      action: "blocked",
      required: true,
      startable: false,
      reason: "not available on this machine",
    });
  });

  it("does not resolve prototype keys as service configs", () => {
    const plan = planTaskServices(req(["constructor"]), [], {});
    expect(plan[0].action).toBe("blocked");
  });

  it("treats a configured service without status as stopped", () => {
    const plan = planTaskServices(req(["db"]), [], { db: {} });
    expect(plan[0]).toMatchObject({ state: "stopped", action: "start" });
  });

  it("returns an empty plan for no requirements", () => {
    expect(planTaskServices(req([]), [], {})).toEqual([]);
  });
});

describe("summarizePlan", () => {
  it("summarizes start/blocked entries", () => {
    expect(
      summarizePlan([
        entry("a", "ok"),
        entry("b", "start", { startable: true }),
        entry("c", "start", { startable: false }),
        entry("d", "blocked"),
      ]),
    ).toEqual({ needsStart: true, autoStart: false, blocked: ["d"] });
  });

  it("autoStart true when every start entry is startable or there are none", () => {
    expect(summarizePlan([entry("a", "start", { startable: true })]).autoStart).toBe(true);
    expect(summarizePlan([entry("a", "ok")])).toEqual({
      needsStart: false,
      autoStart: true,
      blocked: [],
    });
  });
});

describe("ensureTaskServices", () => {
  const { signal } = new AbortController();

  describe("permission", () => {
    it.each<[boolean | undefined, boolean, boolean]>([
      [true, false, true],
      [true, true, true],
      [undefined, true, true],
      [undefined, false, false],
      [false, true, false],
      [false, false, false],
    ])("start=%s startable=%s → permitted=%s", async (start, startable, permitted) => {
      const mgr = new FakeManager({ db: "stopped" });
      const run = ensureTaskServices([entry("db", "start", { startable })], {
        start,
        manager: mgr,
        signal,
      });
      if (permitted) {
        await expect(run).resolves.toEqual({ started: ["db"] });
      } else {
        await expect(run).rejects.toBeInstanceOf(ServicesNotRunningError);
        expect(mgr.startCalls).toEqual([]);
      }
    });

    it("ServicesNotRunningError carries name/state and code", async () => {
      const mgr = new FakeManager({ db: "stopped", api: "error" });
      const err = await ensureTaskServices(
        [entry("db", "start"), entry("api", "start", { state: "error" })],
        { start: false, manager: mgr, signal },
      ).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(ServicesNotRunningError);
      if (err instanceof ServicesNotRunningError) {
        expect(err.code).toBe("services_not_running");
        expect(err.services).toEqual([
          { name: "db", state: "stopped" },
          { name: "api", state: "error" },
        ]);
      }
    });

    it("no start entries: runs even with start=false", async () => {
      const mgr = new FakeManager({ db: "ready" });
      await expect(
        ensureTaskServices([entry("db", "ok")], { start: false, manager: mgr, signal }),
      ).resolves.toEqual({ started: [] });
    });

    it.each([true, false, undefined])("blocked fails regardless of start=%s", async (start) => {
      const mgr = new FakeManager({ db: "stopped" });
      const err = await ensureTaskServices(
        [
          entry("db", "start", { startable: true }),
          entry("x", "blocked", { reason: "binary 'x' not found" }),
        ],
        { start, manager: mgr, signal },
      ).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      if (err instanceof ServiceUnavailableError) {
        expect(err.code).toBe("service_unavailable");
        expect(err.message).toContain("binary 'x' not found");
      }
      expect(mgr.startCalls).toEqual([]);
    });

    it("blocked entry without reason uses the fallback", async () => {
      const mgr = new FakeManager({});
      await expect(
        ensureTaskServices([entry("x", "blocked")], { manager: mgr, signal }),
      ).rejects.toThrow("not available on this machine");
    });
  });

  it("starts in plan order and reports started services and events", async () => {
    const mgr = new FakeManager({ db: "stopped", api: "stopped", web: "ready" });
    const events: TaskServiceEvent[] = [];
    const result = await ensureTaskServices(
      [entry("web", "ok"), entry("db", "start"), entry("api", "start")],
      { start: true, manager: mgr, signal, onEvent: (e) => events.push(e) },
    );
    expect(result).toEqual({ started: ["db", "api"] });
    expect(mgr.startCalls).toEqual(["db", "api"]);
    expect(events).toEqual([
      { name: "db", phase: "starting" },
      { name: "db", phase: "ready" },
      { name: "api", phase: "starting" },
      { name: "api", phase: "ready" },
    ]);
  });

  it("omits noop starts from started", async () => {
    const mgr = new FakeManager({ db: "ready" });
    mgr.behavior = async () => ({ noop: true });
    await expect(
      ensureTaskServices([entry("db", "start")], { start: true, manager: mgr, signal }),
    ).resolves.toEqual({ started: [] });
  });

  it("failed readiness (state error) throws ServiceStartFailedError with lastError", async () => {
    const mgr = new FakeManager({ db: "stopped", api: "stopped" });
    mgr.behavior = async (name, m) => {
      m.set(name, "error", "ready check timed out");
      return { noop: false };
    };
    const err = await ensureTaskServices([entry("db", "start"), entry("api", "start")], {
      start: true,
      manager: mgr,
      signal,
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceStartFailedError);
    if (err instanceof ServiceStartFailedError) {
      expect(err.code).toBe("service_start_failed");
      expect(err.service).toBe("db");
      expect(err.lastError).toBe("ready check timed out");
      expect(err.message).toBe("Service 'db' failed to start: ready check timed out");
    }
    expect(mgr.startCalls).toEqual(["db"]);
  });

  it("wraps a thrown start error", async () => {
    const mgr = new FakeManager({ db: "stopped" });
    mgr.behavior = async () => {
      throw new Error("port 5432 in use");
    };
    await expect(
      ensureTaskServices([entry("db", "start")], { start: true, manager: mgr, signal }),
    ).rejects.toThrow(new ServiceStartFailedError("db", "port 5432 in use"));
  });

  it("waits when start raced into starting", async () => {
    const mgr = new FakeManager({ db: "stopped" });
    mgr.behavior = async (name, m) => {
      m.set(name, "starting");
      setTimeout(() => m.set(name, "ready"), 0);
      return { noop: false };
    };
    await expect(
      ensureTaskServices([entry("db", "start")], { start: true, manager: mgr, signal }),
    ).resolves.toEqual({ started: ["db"] });
    expect(mgr.listenerCount("stateChange")).toBe(0);
  });

  describe("wait entries", () => {
    it("resolves on stateChange to ready", async () => {
      const mgr = new FakeManager({ db: "starting" });
      const events: TaskServiceEvent[] = [];
      const run = ensureTaskServices([entry("db", "wait")], {
        start: false,
        manager: mgr,
        signal,
        onEvent: (e) => events.push(e),
      });
      await Promise.resolve();
      mgr.set("other", "ready");
      mgr.set("db", "restarting");
      mgr.set("db", "ready");
      await expect(run).resolves.toEqual({ started: [] });
      expect(events).toEqual([
        { name: "db", phase: "waiting" },
        { name: "db", phase: "ready" },
      ]);
      expect(mgr.listenerCount("stateChange")).toBe(0);
    });

    it("resolves immediately when already ready", async () => {
      const mgr = new FakeManager({ db: "ready" });
      await expect(
        ensureTaskServices([entry("db", "wait")], { manager: mgr, signal }),
      ).resolves.toEqual({ started: [] });
    });

    it.each<ServiceState>(["error", "stopped"])("fails on %s", async (state) => {
      const mgr = new FakeManager({ db: "starting" });
      const run = ensureTaskServices([entry("db", "wait")], { manager: mgr, signal });
      await Promise.resolve();
      mgr.set("db", state, state === "error" ? "crashed" : undefined);
      await expect(run).rejects.toThrow(
        state === "error"
          ? "Service 'db' failed to start: crashed"
          : "Service 'db' failed to start: stopped",
      );
      expect(mgr.listenerCount("stateChange")).toBe(0);
    });

    it("fails when the service has no status", async () => {
      const mgr = new FakeManager({});
      await expect(
        ensureTaskServices([entry("db", "wait")], { manager: mgr, signal }),
      ).rejects.toBeInstanceOf(ServiceStartFailedError);
    });

    it("waits for a starting dep before starting its dependent", async () => {
      const mgr = new FakeManager({ db: "starting", api: "stopped" });
      const run = ensureTaskServices(
        [entry("db", "wait", { required: false }), entry("api", "start")],
        { start: true, manager: mgr, signal },
      );
      await Promise.resolve();
      expect(mgr.startCalls).toEqual([]);
      mgr.set("db", "ready");
      await expect(run).resolves.toEqual({ started: ["api"] });
    });
  });

  it("emits a heartbeat at least every 30s while waiting", async () => {
    vi.useFakeTimers();
    const mgr = new FakeManager({ db: "starting" });
    const events: TaskServiceEvent[] = [];
    const run = ensureTaskServices([entry("db", "wait")], {
      manager: mgr,
      signal,
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(TASK_SERVICE_HEARTBEAT_MS * 2);
    expect(events).toEqual([
      { name: "db", phase: "waiting" },
      { name: "db", phase: "waiting" },
      { name: "db", phase: "waiting" },
    ]);
    mgr.set("db", "ready");
    await run;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("heartbeat repeats the starting phase during a long start", async () => {
    vi.useFakeTimers();
    const mgr = new FakeManager({ db: "stopped" });
    let finish: () => void = () => undefined;
    mgr.behavior = async (name, m) => {
      m.set(name, "starting");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      m.set(name, "ready");
      return { noop: false };
    };
    const events: TaskServiceEvent[] = [];
    const run = ensureTaskServices([entry("db", "start")], {
      start: true,
      manager: mgr,
      signal,
      onEvent: (e) => events.push(e),
    });
    await vi.advanceTimersByTimeAsync(TASK_SERVICE_HEARTBEAT_MS);
    expect(events).toEqual([
      { name: "db", phase: "starting" },
      { name: "db", phase: "starting" },
    ]);
    finish();
    await run;
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("abort", () => {
    it("rejects before side effects when already aborted", async () => {
      const mgr = new FakeManager({ db: "stopped" });
      const ac = new AbortController();
      ac.abort();
      await expect(
        ensureTaskServices([entry("db", "start")], {
          start: true,
          manager: mgr,
          signal: ac.signal,
        }),
      ).rejects.toThrow("aborted");
      expect(mgr.startCalls).toEqual([]);
    });

    it("rejects promptly while waiting and cleans up listeners and timers", async () => {
      vi.useFakeTimers();
      const mgr = new FakeManager({ db: "ready", api: "starting" });
      const ac = new AbortController();
      const run = ensureTaskServices([entry("api", "wait")], { manager: mgr, signal: ac.signal });
      await vi.advanceTimersByTimeAsync(10);
      expect(mgr.listenerCount("stateChange")).toBe(1);
      ac.abort();
      await expect(run).rejects.toThrow("aborted");
      expect(mgr.listenerCount("stateChange")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects promptly during a hanging start and leaves started services alone", async () => {
      const mgr = new FakeManager({ db: "stopped", api: "stopped" });
      const ac = new AbortController();
      mgr.behavior = async (name, m) => {
        if (name === "db") {
          m.set(name, "ready");
          return { noop: false };
        }
        m.set(name, "starting");
        return new Promise<ServiceActionResult>(() => undefined);
      };
      const run = ensureTaskServices([entry("db", "start"), entry("api", "start")], {
        start: true,
        manager: mgr,
        signal: ac.signal,
      });
      await vi.waitFor(() => {
        expect(mgr.startCalls).toEqual(["db", "api"]);
      });
      ac.abort();
      await expect(run).rejects.toThrow("aborted");
      expect(mgr.statuses.get("db")?.state).toBe("ready");
      expect(mgr.listenerCount("stateChange")).toBe(0);
    });

    it("aborted wait with already-aborted signal does not subscribe", async () => {
      const mgr = new FakeManager({ db: "stopped" });
      const ac = new AbortController();
      mgr.behavior = async (name, m) => {
        m.set(name, "starting");
        ac.abort();
        return { noop: false };
      };
      await expect(
        ensureTaskServices([entry("db", "start")], {
          start: true,
          manager: mgr,
          signal: ac.signal,
        }),
      ).rejects.toThrow("aborted");
      expect(mgr.listenerCount("stateChange")).toBe(0);
    });
  });
});
