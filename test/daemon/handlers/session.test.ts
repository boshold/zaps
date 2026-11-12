import { Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ResolvedConfig, TaskConfig } from "#src/config/types.js";
import type { UiBinding } from "#src/daemon/session.js";
import { TaskExecutionService } from "#src/daemon/task-execution.js";
import { SessionClosingError } from "#src/lib/backend/admission-error.js";
import type { CommandExecutor } from "#src/lib/backend/runtime/command-executor.js";
import { TerminalOperationError } from "#src/lib/backend/terminal-error.js";
import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import type { OperationTmux } from "#src/lib/backend/tmux/operations.js";
import { serviceWrappers } from "#src/lib/backend/tmux/runtime.js";
import type {
  BackendCapabilities,
  PresentationSnapshot,
  SessionBackend,
  TerminalDriver,
} from "#src/lib/backend/types.js";
import { taskListEntrySchema, taskPreflightSchema } from "#src/lib/backend/wire.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { createServiceStatus } from "#src/lib/service/state.js";
import {
  ServiceStartFailedError,
  ServiceUnavailableError,
  ServicesNotRunningError,
} from "#src/lib/task/ensure-services.js";

import { ConfigError } from "../../../src/config/errors.js";
import { sessionHandlers } from "../../../src/daemon/handlers/session.js";
import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import { SENTRA_BLOCK, fakeSentra, fakeSentraDsn } from "../../_helpers/fake-sentra.js";
import {
  createMockSession as createBaseMockSession,
  createMockStore,
} from "../../_helpers/mock-session.js";
import { createMockSocket } from "../../_helpers/mock-socket.js";

vi.mock("../../../src/lib/service/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/service/env.js")>()),
  buildServiceContext: vi.fn(() => ({})),
  resolveEnv: vi.fn(() => ({})),
}));

function createMockSession(...args: Parameters<typeof createBaseMockSession>) {
  const session = createBaseMockSession(...args);
  const terminal = {
    reconcileLayout: vi.fn<TerminalDriver["reconcileLayout"]>().mockResolvedValue(undefined),
    focus: vi.fn<TerminalDriver["focus"]>().mockResolvedValue(undefined),
    zoom: vi.fn<TerminalDriver["zoom"]>().mockResolvedValue(undefined),
    editOutput: vi.fn<TerminalDriver["editOutput"]>().mockResolvedValue(undefined),
    taskPicker: vi.fn<TerminalDriver["taskPicker"]>().mockResolvedValue(null),
    taskOutput: vi.fn<TerminalDriver["taskOutput"]>().mockResolvedValue(undefined),
    runTaskInPane: vi
      .fn<TerminalDriver["runTaskInPane"]>()
      .mockImplementation(async (spec, operation) => {
        operation.signal.throwIfAborted();
        session.panesByRun.set(spec.runId, spec.target === "pane" ? "%split" : "%win");
        return {
          id: spec.runId,
          unitId: spec.execution.unitId,
          generation: spec.execution.generation,
        };
      }),
  } satisfies TerminalDriver;
  return Object.assign(session, {
    backend: { terminal, capabilities: { taskPanes: true } },
    taskExecution: { accepting: true },
  });
}

const taskOwners: TaskExecutionService[] = [];

function taskSession(tasks: Record<string, TaskConfig>) {
  const session = createMockSession();
  const config: ResolvedConfig = {
    project: { name: "test", services: {}, tasks },
    configPath: "/fake/.zaps.mts",
    projectDir: "/fake",
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
  const execute = vi.fn<CommandExecutor["execute"]>().mockImplementation(async (_command, opts) => {
    opts.onLine?.("command output");
    return { success: true, exitCode: 0, output: ["command output"] };
  });
  const displayPopup = vi.fn().mockResolvedValue(undefined);
  const env = { TOKEN: "session" };
  const broadcast = vi.fn<(event: DaemonEvent) => void>();
  const owner = new TaskExecutionService(
    {
      id: session.id,
      config,
      env,
      manager: {
        startService: async () => ({ noop: false }),
        restartService: async () => {
          /* Noop */
        },
        stopService: async () => ({ noop: false }),
        getAllStatuses: () => [createServiceStatus("api")],
      },
      deps: {},
      backend: {
        terminal: {
          runConfiguredTask: async (request) => {
            await displayPopup(request);
            return { kind: "completed", exitCode: 0 };
          },
        },
      },
      broadcast,
    },
    () => ({ execute }),
  );
  taskOwners.push(owner);
  return {
    session: Object.assign(session, { config, env, taskExecution: owner, broadcast }),
    owner,
    execute,
    displayPopup,
    broadcast,
  };
}

describe("session handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(taskOwners.splice(0).map(async (owner) => owner.dispose()));
    vi.restoreAllMocks();
  });

  describe("session.attach", () => {
    it.each([undefined, {}, { ui: false }])(
      "preserves snapshot-only attachment for %j",
      async (params) => {
        const bindUi = vi.fn();
        const session = Object.assign(createMockSession(), { bindUi });
        const res = await sessionHandlers["session.attach"](
          { id: "a", method: "session.attach", session: session.id, params },
          createMockStore([session]),
          createMockSocket() as never,
        );
        expect(res.error).toBeUndefined();
        expect(session.attachSnapshot).toHaveBeenCalledOnce();
        expect(bindUi).not.toHaveBeenCalled();
      },
    );

    it.each([null, [], true, { ui: "true" }, { ui: true, client: "other" }])(
      "rejects malformed attachment without effects: %j",
      async (params) => {
        const bindUi = vi.fn();
        const session = Object.assign(createMockSession(), { bindUi });
        const res = await sessionHandlers["session.attach"](
          { id: "a", method: "session.attach", session: session.id, params },
          createMockStore([session]),
          createMockSocket() as never,
        );
        expect(res.error).toBe("invalid_request");
        expect(bindUi).not.toHaveBeenCalled();
        expect(session.attachSnapshot).not.toHaveBeenCalled();
      },
    );

    it.each(["invalid_request", "session_closing"])(
      "rejects invalid binding before snapshot: %s",
      async (message) => {
        const bindUi = vi.fn(() => {
          throw new Error(message);
        });
        const session = Object.assign(createMockSession(), { bindUi });
        const res = await sessionHandlers["session.attach"](
          { id: "a", method: "session.attach", session: session.id, params: { ui: true } },
          createMockStore([session]),
          createMockSocket() as never,
        );
        expect(res.error).toBe(message);
        expect(session.attachSnapshot).not.toHaveBeenCalled();
      },
    );

    it("returns attach snapshot", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r1", method: "session.attach", session: session.id };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.id).toBe("r1");
      expect(session.attachSnapshot).toHaveBeenCalled();
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r2", method: "session.attach", session: "unknown" };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });

    it("returns error when session field is missing", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r2b", method: "session.attach" };
      const res = await sessionHandlers["session.attach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("session.reload", () => {
    it("calls reload on session", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload", method: "session.reload", session: session.id };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.result).toEqual({ reloaded: true });
      expect(session.reload).toHaveBeenCalled();
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload2", method: "session.reload", session: "bad" };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });

    it("returns error when reload fails", async () => {
      const session = createMockSession();
      session.reload = vi.fn().mockRejectedValue(new Error("Config invalid"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload3", method: "session.reload", session: session.id };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);
      expect(res.error).toBe("Config invalid");
    });

    it("logs the full ConfigError and keeps the session, surfacing only the message", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const session = createMockSession();
      const managerBefore = session.manager;
      const paneMapBefore = session.paneMap;
      session.reload = vi.fn().mockRejectedValue(
        new ConfigError("cwd function returned a non-string value (undefined)", {
          kind: "validation",
          field: "cwd",
          file: "/proj/.zaps.ts",
        }),
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r-reload4", method: "session.reload", session: session.id };
      const res = await sessionHandlers["session.reload"](req, store, socket as never);

      expect(res.error).toBe("cwd function returned a non-string value (undefined)");
      const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("kind=validation");
      expect(logged).toContain("field=cwd");
      expect(logged).toContain("file=/proj/.zaps.ts");
      // The running session is left fully intact (A1).
      expect(session.manager).toBe(managerBefore);
      expect(session.paneMap).toBe(paneMapBefore);
      stderr.mockRestore();
    });
  });

  describe("session.detach", () => {
    it("removes socket from subscribers", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      session.subscribers.add(socket);
      const req: IpcRequest = { id: "r3", method: "session.detach", session: session.id };
      const res = await sessionHandlers["session.detach"](req, store, socket as never);
      expect(res.result).toEqual({ detached: true });
      expect(session.subscribers.has(socket)).toBe(false);
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r4", method: "session.detach", session: "bad" };
      const res = await sessionHandlers["session.detach"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("subscribe", () => {
    it("adds socket to subscribers", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r5",
        method: "subscribe",
        session: session.id,
        params: { events: [] },
      };
      const res = await sessionHandlers.subscribe(req, store, socket as never);
      expect(res.result).toEqual({ subscribed: true });
      expect(session.subscribers.has(socket)).toBe(true);
    });

    it("does not stack a close listener per subscribe call (D7)", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r6",
        method: "subscribe",
        session: session.id,
        params: { events: [] },
      };

      // Subscribing many times on one connection must not register any socket
      // Close listeners — server-level cleanup owns removal, not the handler.
      for (let i = 0; i < 15; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential subscribes on one socket
        await sessionHandlers.subscribe(req, store, socket as never);
      }

      expect(socket.listenerCount("close")).toBe(0);
      expect(session.subscribers.has(socket)).toBe(true);
    });
  });

  describe("services.list", () => {
    it("returns all statuses", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = { id: "r7", method: "services.list", session: session.id };
      const res = await sessionHandlers["services.list"](req, store, socket as never);
      expect(session.manager.getAllStatuses).toHaveBeenCalled();
      expect(res.error).toBeUndefined();
    });

    it("adds errorCount from the sentra counter", async () => {
      const session = createMockSession();
      session.manager.getAllStatuses.mockReturnValue([
        { name: "web", state: "ready", ports: [], retryCount: 0, sentra: true, startedAt: 5 },
        { name: "fresh", state: "ready", ports: [], retryCount: 0, sentra: true },
        { name: "down", state: "ready", ports: [], retryCount: 0, sentra: false },
        { name: "db", state: "ready", ports: [], retryCount: 0 },
      ]);
      const store = createMockStore([session]);
      store.sentraCounter.reset(session.id, "web", 5);
      const req: IpcRequest = { id: "r7b", method: "services.list", session: session.id };
      const res = await sessionHandlers["services.list"](req, store, createMockSocket() as never);
      expect(res.result).toEqual([
        expect.objectContaining({ name: "web", sentra: true, startedAt: 5, errorCount: 0 }),
        expect.objectContaining({ name: "fresh", errorCount: 0 }),
        expect.objectContaining({ name: "down", errorCount: null }),
        expect.objectContaining({ name: "db", sentra: false, errorCount: null }),
      ]);
      expect(session.manager.getAllStatuses.mock.results[0]?.value[0]).not.toHaveProperty(
        "errorCount",
      );
    });
  });

  describe("services.details", () => {
    it("returns service details", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r8",
        method: "services.details",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      expect(res.error).toBeUndefined();
      const result = res.result as Record<string, unknown>;
      expect(result.name).toBe("api");
    });

    it("returns error for unknown service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r9",
        method: "services.details",
        session: session.id,
        params: { name: "unknown" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      expect(res.error).toContain("Unknown service");
    });
  });

  describe("services.start", () => {
    it("starts service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r10",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.result).toEqual({ started: "api", noop: false });
      expect(session.manager.startService).toHaveBeenCalledWith("api");
    });

    it("returns error when start rejects with non-Error", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue("string rejection"); // eslint-disable-line prefer-promise-reject-errors
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r11ne",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.error).toBe("string rejection");
    });

    it("returns error when start fails", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue(new Error("start failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r11",
        method: "services.start",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.start"](req, store, socket as never);
      expect(res.error).toBe("start failed");
    });
  });

  describe("services.stop", () => {
    it("stops service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: "api", noop: false });
    });

    it("returns error when stop rejects with non-Error", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue("stop string"); // eslint-disable-line prefer-promise-reject-errors
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12ne",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.error).toBe("stop string");
    });

    it("returns error when stop fails", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue(new Error("stop failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r12b",
        method: "services.stop",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.stop"](req, store, socket as never);
      expect(res.error).toBe("stop failed");
    });
  });

  describe("services.rebuild", () => {
    it.each([true, false])(
      "rejects grouped rebuild before manager entry (owner=%s)",
      async (isOwner) => {
        const session = createMockSession();
        session.config.project.services.api = {
          docker: { service: "api", build: true },
          _combined: { group: "infra", allServices: ["api", "db"], isOwner },
        };
        const manager = Object.assign(session.manager, { restartWithDockerOverrides: vi.fn() });
        const configBefore = structuredClone(session.config.project.services);
        const panesBefore = { ...session.paneMap };
        const execBefore = new Map(session.execInfo);
        const buffersBefore = new Map(session.logBuffers);
        const store = createMockStore([session]);
        for (const overrides of [{}, { build: true, forceRecreate: true }]) {
          const res = await sessionHandlers["services.rebuild"](
            {
              id: "rebuild",
              method: "services.rebuild",
              session: session.id,
              params: { name: "api", overrides },
            },
            store,
            createMockSocket() as never,
          );
          expect(res).toEqual({
            id: "rebuild",
            errorCode: "unsupported_config",
            error: "Rebuild is not supported for grouped Docker service 'api'; use plain restart.",
          });
        }
        expect(manager.restartWithDockerOverrides).not.toHaveBeenCalled();
        expect(manager.startService).not.toHaveBeenCalled();
        expect(manager.stopService).not.toHaveBeenCalled();
        expect(manager.restartService).not.toHaveBeenCalled();
        expect(manager.emit).not.toHaveBeenCalled();
        expect(session.config.project.services).toEqual(configBefore);
        expect(session.paneMap).toEqual(panesBefore);
        expect(session.execInfo).toEqual(execBefore);
        expect(session.logBuffers).toEqual(buffersBefore);
      },
    );

    it("retains standalone rebuild", async () => {
      const session = createMockSession();
      session.config.project.services.api = { docker: { service: "api" } };
      const manager = Object.assign(session.manager, {
        restartWithDockerOverrides: vi.fn().mockResolvedValue(undefined),
      });
      const res = await sessionHandlers["services.rebuild"](
        {
          id: "rebuild",
          method: "services.rebuild",
          session: session.id,
          params: { name: "api", overrides: { build: true } },
        },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.result).toEqual({ rebuilt: "api" });
      expect(manager.restartWithDockerOverrides).toHaveBeenCalledWith("api", { build: true });
    });
  });

  describe("services.restart", () => {
    it("restarts service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r13",
        method: "services.restart",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.restart"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: "api" });
      expect(session.manager.restartService).toHaveBeenCalledWith("api");
    });

    it("returns error when restart fails", async () => {
      const session = createMockSession();
      session.manager.restartService.mockRejectedValue(new Error("restart failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r13b",
        method: "services.restart",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.restart"](req, store, socket as never);
      expect(res.error).toBe("restart failed");
    });
  });

  describe("services.startAll", () => {
    it("starts all services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r14",
        method: "services.startAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.result).toEqual({ started: "all" });
      expect(session.manager.startAll).toHaveBeenCalled();
    });

    it("starts named services sequentially", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r15",
        method: "services.startAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.result).toEqual({ started: ["api"] });
      expect(session.manager.startService).toHaveBeenCalledWith("api");
    });

    it("returns error on failure", async () => {
      const session = createMockSession();
      session.manager.startAll.mockRejectedValue(new Error("boom"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r16",
        method: "services.startAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.error).toBe("boom");
    });

    it.each([undefined, {}, { startup: true }])(
      "begins the deferred startup of a task-only session for %j",
      async (params) => {
        const session = createMockSession({ startupPending: true });
        const res = await sessionHandlers["services.startAll"](
          { id: "r", method: "services.startAll", session: session.id, params },
          createMockStore([session]),
          createMockSocket() as never,
        );
        expect(res.result).toEqual({ started: "all" });
        expect(session.beginInitialStartup).toHaveBeenCalledTimes(1);
        if (params && "startup" in params) {
          expect(session.waitForInitialStartup).toHaveBeenCalledTimes(1);
          expect(session.manager.startAll).not.toHaveBeenCalled();
        } else {
          expect(session.manager.startAll).toHaveBeenCalledTimes(1);
        }
      },
    );

    it("leaves the deferred startup pending for named starts", async () => {
      const session = createMockSession({ startupPending: true });
      const res = await sessionHandlers["services.startAll"](
        {
          id: "r",
          method: "services.startAll",
          session: session.id,
          params: { names: ["api"] },
        },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.result).toEqual({ started: ["api"] });
      expect(session.beginInitialStartup).not.toHaveBeenCalled();
    });

    it("does not re-begin startup on regular sessions", async () => {
      const session = createMockSession();
      await sessionHandlers["services.startAll"](
        { id: "r", method: "services.startAll", session: session.id, params: { startup: true } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(session.beginInitialStartup).not.toHaveBeenCalled();
      expect(session.waitForInitialStartup).toHaveBeenCalledTimes(1);
    });

    it("returns error when named services start fails", async () => {
      const session = createMockSession();
      session.manager.startService.mockRejectedValue(new Error("named start failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r16b",
        method: "services.startAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.startAll"](req, store, socket as never);
      expect(res.error).toBe("named start failed");
    });
  });

  describe("services.details (dependsOn)", () => {
    it("returns dependsOn array when set", async () => {
      const session = createMockSession();
      session.config.project.services = {
        api: { start: "npm dev", dependsOn: ["db"] },
      };
      session.manager.getStatus.mockReturnValue({
        name: "api",
        state: "ready",
        ports: [3000],
        retryCount: 0,
      });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rdo1",
        method: "services.details",
        session: session.id,
        params: { name: "api" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      const result = res.result as Record<string, unknown>;
      expect(result.dependsOn).toEqual(["db"]);
    });
  });

  describe("services.details (docker)", () => {
    it("returns hasDocker true when docker is configured", async () => {
      const session = createMockSession();
      session.config.project.services = {
        db: { docker: { service: "postgres" } },
      };
      session.manager.getStatus.mockReturnValue({
        name: "db",
        state: "ready",
        ports: [5432],
        retryCount: 0,
      });
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rd1",
        method: "services.details",
        session: session.id,
        params: { name: "db" },
      };
      const res = await sessionHandlers["services.details"](req, store, socket as never);
      const result = res.result as Record<string, unknown>;
      expect(result.hasDocker).toBe(true);
    });
  });

  describe("services.stopAll", () => {
    it("stops all services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r17",
        method: "services.stopAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: "all" });
    });

    it("stops named services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18",
        method: "services.stopAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.result).toEqual({ stopped: ["api"] });
    });

    it("returns error when named services stop fails", async () => {
      const session = createMockSession();
      session.manager.stopService.mockRejectedValue(new Error("named stop failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18c",
        method: "services.stopAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.error).toBe("named stop failed");
    });

    it("returns error when stopAll fails", async () => {
      const session = createMockSession();
      session.manager.stopAll.mockRejectedValue(new Error("stopAll failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r18b",
        method: "services.stopAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.stopAll"](req, store, socket as never);
      expect(res.error).toBe("stopAll failed");
    });
  });

  describe("services.restartAll", () => {
    it("restarts all services (stop + start)", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r19",
        method: "services.restartAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: "all" });
      expect(session.manager.stopAll).toHaveBeenCalled();
      expect(session.manager.startAll).toHaveBeenCalled();
    });

    it("restarts named services", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20",
        method: "services.restartAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.result).toEqual({ restarted: ["api"] });
    });

    it("returns error when named services restart fails", async () => {
      const session = createMockSession();
      session.manager.restartService.mockRejectedValue(new Error("named restart failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20c",
        method: "services.restartAll",
        session: session.id,
        params: { names: ["api"] },
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.error).toBe("named restart failed");
    });

    it("returns error when restartAll fails", async () => {
      const session = createMockSession();
      session.manager.stopAll.mockRejectedValue(new Error("restartAll failed"));
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r20b",
        method: "services.restartAll",
        session: session.id,
      };
      const res = await sessionHandlers["services.restartAll"](req, store, socket as never);
      expect(res.error).toBe("restartAll failed");
    });
  });

  describe("tasks.list", () => {
    it("returns task list", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        build: { name: "Build", description: "Build the project" },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r21",
        method: "tasks.list",
        session: session.id,
      };
      const res = await sessionHandlers["tasks.list"](req, store, socket as never);
      const result = res.result as { key: string; name: string }[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ key: "build", name: "Build" });
    });

    it("returns empty list when no tasks", async () => {
      const session = createMockSession();
      session.config.project.tasks = undefined;
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r22",
        method: "tasks.list",
        session: session.id,
      };
      const res = await sessionHandlers["tasks.list"](req, store, socket as never);
      expect(res.result).toEqual([]);
    });

    it("includes services, requiredServices, autoStart and dependsOn", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        migrate: { name: "Migrate", commands: "m", services: ["db"], autoStart: true },
        seed: { name: "Seed", commands: "s", services: ["api"], dependsOn: ["migrate"] },
        lint: { name: "Lint", commands: "l" },
      };
      const res = await sessionHandlers["tasks.list"](
        { id: "r", method: "tasks.list", session: session.id },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(z.array(taskListEntrySchema).parse(res.result)).toEqual([
        {
          key: "migrate",
          name: "Migrate",
          description: null,
          services: ["db"],
          requiredServices: ["db"],
          autoStart: true,
          dependsOn: [],
        },
        {
          key: "seed",
          name: "Seed",
          description: null,
          services: ["api"],
          requiredServices: ["db", "api"],
          autoStart: false,
          dependsOn: ["migrate"],
        },
        {
          key: "lint",
          name: "Lint",
          description: null,
          services: [],
          requiredServices: [],
          autoStart: false,
          dependsOn: [],
        },
      ]);
    });

    it("returns error for unknown session", async () => {
      const res = await sessionHandlers["tasks.list"](
        { id: "r", method: "tasks.list", session: "nope" },
        createMockStore([]),
        createMockSocket() as never,
      );
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("tasks.preflight", () => {
    function preflightSession() {
      const session = createMockSession();
      session.config.project.services = {
        api: { start: "npm dev", dependsOn: ["db"] },
        db: { start: "pg" },
      };
      session.config.unavailableServices = new Map([
        ["mail", { name: "mail", reason: "binary 'mailhog' not found" }],
      ]);
      session.manager.getAllStatuses.mockReturnValue([
        { name: "api", state: "stopped", ports: [], retryCount: 0 },
        { name: "db", state: "stopped", ports: [], retryCount: 0 },
        { name: "mail", state: "unavailable", ports: [], retryCount: 0 },
      ]);
      session.config.project.tasks = {
        seed: { name: "Seed", commands: "s", services: ["api"], autoStart: true },
        mail: { name: "Mail", commands: "m", services: ["mail"] },
        lint: { name: "Lint", commands: "l" },
      };
      return session;
    }

    async function preflight(session: ReturnType<typeof createMockSession>, params: unknown) {
      return sessionHandlers["tasks.preflight"](
        { id: "p", method: "tasks.preflight", session: session.id, params },
        createMockStore([session]),
        createMockSocket() as never,
      );
    }

    it("returns the plan and summary without side effects", async () => {
      const session = preflightSession();
      const res = await preflight(session, { key: "seed" });
      expect(taskPreflightSchema.parse(res.result)).toEqual({
        key: "seed",
        services: [
          { name: "db", state: "stopped", action: "start", required: false, startable: true },
          { name: "api", state: "stopped", action: "start", required: true, startable: true },
        ],
        needsStart: true,
        autoStart: true,
        blocked: [],
      });
      expect(session.manager.startService).not.toHaveBeenCalled();
      expect(session.manager.startAll).not.toHaveBeenCalled();
    });

    it("reports blocked services with reason", async () => {
      const res = await preflight(preflightSession(), { key: "mail" });
      expect(taskPreflightSchema.parse(res.result)).toMatchObject({
        services: [{ name: "mail", action: "blocked", reason: "binary 'mailhog' not found" }],
        needsStart: false,
        blocked: ["mail"],
      });
    });

    it("returns an empty plan for an independent task", async () => {
      const res = await preflight(preflightSession(), { key: "lint" });
      expect(res.result).toEqual({
        key: "lint",
        services: [],
        needsStart: false,
        autoStart: true,
        blocked: [],
      });
    });

    it.each(["missing", "constructor"])("returns Unknown task for %s", async (key) => {
      const res = await preflight(preflightSession(), { key });
      expect(res.error).toBe(`Unknown task: ${key}`);
    });

    it("returns Unknown session", async () => {
      const res = await sessionHandlers["tasks.preflight"](
        { id: "p", method: "tasks.preflight", session: "nope", params: { key: "seed" } },
        createMockStore([]),
        createMockSocket() as never,
      );
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("tasks.run", () => {
    it("returns error for unknown task", async () => {
      const { session } = taskSession({});
      const res = await sessionHandlers["tasks.run"](
        { id: "run", method: "tasks.run", session: session.id, params: { key: "missing" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.error).toContain("Unknown task");
      expect(session.acquireTask).toHaveBeenCalledTimes(1);
      expect(session.release).toHaveBeenCalledTimes(1);
    });

    it("holds a pending task from before preparation until the run settles", async () => {
      const { session } = taskSession({ seed: { name: "Seed", commands: "s" } });
      let finishPrepare: (value: { startedServices: string[] }) => void = () => undefined;
      session.prepareTask.mockImplementation(
        async () =>
          new Promise((resolve) => {
            finishPrepare = resolve;
          }),
      );
      const pending = sessionHandlers["tasks.run"](
        { id: "run", method: "tasks.run", session: session.id, params: { key: "seed" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(session.acquireTask).toHaveBeenCalledTimes(1);
      expect(session.release).not.toHaveBeenCalled();
      finishPrepare({ startedServices: [] });
      await pending;
      expect(session.release).toHaveBeenCalledTimes(1);
    });

    it("releases the pending task when request parsing throws", async () => {
      const { session } = taskSession({});
      await expect(
        sessionHandlers["tasks.run"](
          { id: "run", method: "tasks.run", session: session.id, params: { key: 42 } },
          createMockStore([session]),
          createMockSocket() as never,
        ),
      ).rejects.toThrow();
      expect(session.release).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("runs popup DAG in background with UI binding %s", async (bound) => {
      const { session, execute, displayPopup, owner } = taskSession({
        shared: { name: "Shared", popup: true, commands: "shared" },
        nested: { name: "Nested", popup: true, commands: () => "nested", dependsOn: ["shared"] },
        callback: {
          name: "Callback",
          dependsOn: ["shared"],
          run: async (ctx) => {
            ctx.stdout.write("callback output\n");
            await ctx.exec("callback");
          },
        },
        root: { name: "Root", popup: true, commands: "root", dependsOn: ["nested", "callback"] },
      });
      const socket = createMockSocket();
      Object.assign(socket, { writable: true, destroyed: false });
      if (bound) {
        session.subscribers.add(socket);
      }
      const res = await sessionHandlers["tasks.run"](
        { id: "run", method: "tasks.run", session: session.id, params: { key: "root" } },
        createMockStore([session]),
        socket as never,
      );
      expect(res.result).toMatchObject({ success: true, runId: expect.any(String) });
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        "shared",
        "nested",
        "callback",
        "root",
      ]);
      expect(displayPopup).not.toHaveBeenCalled();
      expect(owner.history).toEqual([
        expect.objectContaining({ taskKey: "root", result: "success" }),
      ]);
      const runId = owner.history[0]?.runId ?? "missing";
      expect(owner.output.get(runId)?.lines).toContain("callback output");
      expect(session.broadcast.mock.calls.map(([event]) => event.event)).toEqual([
        "task.start",
        "task.complete",
      ]);
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"event":"line"'));
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"event":"progress"'));
    });

    it("failed popup prerequisite suppresses root and completes once", async () => {
      const { session, execute, owner } = taskSession({
        dep: { name: "Dep", popup: true, commands: "fail" },
        root: { name: "Root", popup: true, commands: "root", dependsOn: ["dep"] },
      });
      execute.mockResolvedValue({ success: false, exitCode: 1, output: [] });
      const res = await sessionHandlers["tasks.run"](
        { id: "run", method: "tasks.run", session: session.id, params: { key: "root" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.result).toMatchObject({ success: false });
      expect(execute.mock.calls.map(([command]) => command)).toEqual(["fail"]);
      expect(owner.history).toEqual([
        expect.objectContaining({ taskKey: "root", result: "error" }),
      ]);
      expect(
        session.broadcast.mock.calls.filter(([event]) => event.event === "task.complete"),
      ).toHaveLength(1);
    });

    it("closed request output sinks leave execution and retention intact", async () => {
      const { session, owner } = taskSession({ root: { name: "Root", commands: "root" } });
      const socket = createMockSocket();
      Object.assign(socket, { writable: false, destroyed: true });
      socket.write.mockImplementation(() => {
        throw new Error("closed");
      });
      const res = await sessionHandlers["tasks.run"](
        { id: "run", method: "tasks.run", session: session.id, params: { key: "root" } },
        createMockStore([session]),
        socket as never,
      );
      expect(res.result).toMatchObject({ success: true });
      expect(socket.write).not.toHaveBeenCalled();
      expect(owner.output.get(owner.history[0]?.runId ?? "missing")?.lines).toEqual([
        "command output",
      ]);
    });
  });

  describe("task service preparation", () => {
    function runReq(session: { id: string }, params: unknown): IpcRequest {
      return { id: "run", method: "tasks.run", session: session.id, params };
    }

    it("tasks.run prepares first, forwards service events and returns startedServices", async () => {
      const { session, execute, owner } = taskSession({
        seed: { name: "Seed", commands: "seed", services: ["db"] },
      });
      const order: string[] = [];
      session.prepareTask.mockImplementation(async (_key, opts) => {
        order.push("prepare");
        opts?.onEvent?.({ name: "db", phase: "starting" });
        return { startedServices: ["db"] };
      });
      execute.mockImplementation(async () => {
        order.push("execute");
        return { success: true, exitCode: 0, output: [] };
      });
      const socket = Object.assign(createMockSocket(), { writable: true });
      const res = await sessionHandlers["tasks.run"](
        runReq(session, { key: "seed", start: true }),
        createMockStore([session]),
        socket as never,
      );
      expect(order).toEqual(["prepare", "execute"]);
      expect(session.prepareTask).toHaveBeenCalledWith("seed", {
        start: true,
        signal: expect.any(AbortSignal),
        onEvent: expect.any(Function),
      });
      expect(res.result).toEqual({
        success: true,
        runId: expect.any(String),
        startedServices: ["db"],
      });
      expect(socket.write).toHaveBeenCalledWith(
        `${JSON.stringify({ id: "run", event: "service", data: { name: "db", phase: "starting" } })}\n`,
      );
      expect(owner.history[0]).toMatchObject({ taskKey: "seed", startedServices: ["db"] });
      expect(socket.listenerCount("close")).toBe(0);
    });

    it("tasks.run without services keeps the record shape", async () => {
      const { session, owner } = taskSession({ lint: { name: "Lint", commands: "lint" } });
      const res = await sessionHandlers["tasks.run"](
        runReq(session, { key: "lint" }),
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.result).toMatchObject({ success: true, startedServices: [] });
      expect(owner.history[0]).not.toHaveProperty("startedServices");
    });

    it.each([
      [
        new ServicesNotRunningError([{ name: "db", state: "stopped" }], "seed"),
        "services_not_running",
      ],
      [new ServiceStartFailedError("db", "boom"), "service_start_failed"],
      [new ServiceUnavailableError([{ name: "db", reason: "missing" }]), "service_unavailable"],
      [new SessionClosingError(), "session_closing"],
    ])("tasks.run maps %s to %s without executing anything", async (failure, code) => {
      const { session, execute, owner, broadcast } = taskSession({
        dep: { name: "Dep", commands: "dep" },
        seed: { name: "Seed", commands: "seed", services: ["db"], dependsOn: ["dep"] },
      });
      session.prepareTask.mockRejectedValue(failure);
      const res = await sessionHandlers["tasks.run"](
        runReq(session, { key: "seed" }),
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res).toEqual({ id: "run", error: failure.message, errorCode: code });
      expect(execute).not.toHaveBeenCalled();
      expect(session.release).toHaveBeenCalledTimes(1);
      expect(owner.history).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("tasks.run reports a closing session as unknown before preparing", async () => {
      const { session, owner, execute } = taskSession({ seed: { name: "Seed", commands: "s" } });
      owner.close();
      const res = await sessionHandlers["tasks.run"](
        runReq(session, { key: "seed" }),
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res).toEqual({ id: "run", error: "Unknown session" });
      expect(session.prepareTask).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it("tasks.run reports unknown session when the session closes during preparation", async () => {
      const { session, owner, execute } = taskSession({
        seed: { name: "Seed", commands: "s", services: ["db"] },
      });
      session.prepareTask.mockImplementation(async () => {
        owner.close();
        throw new SessionClosingError();
      });
      const res = await sessionHandlers["tasks.run"](
        runReq(session, { key: "seed" }),
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res).toEqual({ id: "run", error: "Unknown session" });
      expect(execute).not.toHaveBeenCalled();
    });

    it("tasks.run aborts preparation when the socket closes", async () => {
      const { session } = taskSession({ seed: { name: "Seed", commands: "s", services: ["db"] } });
      let seen: AbortSignal | undefined;
      session.prepareTask.mockImplementation(
        async (_key, opts) =>
          new Promise((_resolve, reject) => {
            seen = opts?.signal;
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const socket = createMockSocket();
      const pending = sessionHandlers["tasks.run"](
        runReq(session, { key: "seed" }),
        createMockStore([session]),
        socket as never,
      );
      await vi.waitFor(() => {
        expect(seen).toBeDefined();
      });
      socket.destroyed = true;
      socket.emit("close");
      await expect(pending).resolves.toMatchObject({ error: "aborted" });
      expect(seen?.aborted).toBe(true);
    });

    it("tasks.run aborts immediately when the socket is already closed", async () => {
      const { session } = taskSession({ seed: { name: "Seed", commands: "s", services: ["db"] } });
      const socket = createMockSocket();
      socket.destroyed = true;
      await sessionHandlers["tasks.run"](
        runReq(session, { key: "seed" }),
        createMockStore([session]),
        socket as never,
      );
      expect(session.prepareTask.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it("tasks.runInPane prepares before the status snapshot and records startedServices", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        seed: { name: "Seed", commands: "echo seed", services: ["api"] },
      };
      const order: string[] = [];
      session.prepareTask.mockImplementation(async () => {
        order.push("prepare");
        return { startedServices: ["api"] };
      });
      session.manager.getAllStatuses.mockImplementation(() => {
        order.push("snapshot");
        return [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }];
      });
      const res = await sessionHandlers["tasks.runInPane"](
        {
          id: "pane",
          method: "tasks.runInPane",
          session: session.id,
          params: { key: "seed", start: false },
        },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.result).toMatchObject({ runId: expect.any(String) });
      expect(order[0]).toBe("prepare");
      expect(session.prepareTask).toHaveBeenCalledWith("seed", {
        start: false,
        signal: expect.any(AbortSignal),
        onEvent: undefined,
      });
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "pane", startedServices: ["api"] }),
      );
    });

    it("tasks.runInPane returns service errors before creating anything", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        seed: { name: "Seed", commands: "echo seed", services: ["api"] },
      };
      session.prepareTask.mockRejectedValue(
        new ServicesNotRunningError([{ name: "api", state: "stopped" }], "seed"),
      );
      const res = await sessionHandlers["tasks.runInPane"](
        { id: "pane", method: "tasks.runInPane", session: session.id, params: { key: "seed" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res.errorCode).toBe("services_not_running");
      expect(session.pushTaskRecord).not.toHaveBeenCalled();
      expect(session.broadcast).not.toHaveBeenCalled();
      expect(session.backend.terminal.runTaskInPane).not.toHaveBeenCalled();
      expect(session.paneRunInfo.size).toBe(0);
    });

    it("tasks.preflight rejects unexpected params with invalid_request", async () => {
      const session = createMockSession();
      session.config.project.tasks = { seed: { name: "Seed", commands: "s" } };
      const res = await sessionHandlers["tasks.preflight"](
        {
          id: "p",
          method: "tasks.preflight",
          session: session.id,
          params: { key: "seed", start: true },
        },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(res).toEqual({ id: "p", error: "invalid_request", errorCode: "invalid_request" });
    });
  });

  describe("tasks.runInPane", () => {
    it("runs only root commands even when dependencies are configured", async () => {
      const session = createMockSession();
      const dependency = vi.fn();
      session.config.project.tasks = {
        dep: { name: "Dep", run: dependency },
        root: { name: "Root", commands: "echo root", dependsOn: ["dep"] },
      };
      const result = await sessionHandlers["tasks.runInPane"](
        { id: "pane", method: "tasks.runInPane", session: session.id, params: { key: "root" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(result.result).toMatchObject({ runId: expect.any(String) });
      expect([...session.paneRunInfo.values()].map((info) => info.command)).toEqual(["echo root"]);
      expect(dependency).not.toHaveBeenCalled();
    });

    it("returns unknown_task for a missing key", async () => {
      const session = createMockSession();
      session.config.project.tasks = {};
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp1",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "missing" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toBe("unknown_task");
    });

    it("creates a new window by default and returns runId + paneId", async () => {
      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp2",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      const result = res.result as { runId: string; paneId: string };
      expect(result.runId).toEqual(expect.any(String));
      expect(result.paneId).toBe("%win");
      expect(session.backend.terminal.runTaskInPane).toHaveBeenCalledExactlyOnceWith(
        {
          taskKey: "build",
          runId: result.runId,
          target: "window",
          execution: {
            unitId: "build",
            generation: 0,
            command: `zaps -s abc123 exec-task ${result.runId}`,
            cwd: "/fake",
            env: {},
            placement: "default",
            raw: false,
          },
        },
        { id: result.runId, cwd: "/fake", env: {}, signal: expect.any(AbortSignal) },
      );
      // Stores runId → paneId so the pane can later be addressed (T04).
      expect(session.panesByRun.get(result.runId)).toBe("%win");
      // Stashes the resolve info the wrapper fetches over IPC.
      expect(session.paneRunInfo.get(result.runId)).toMatchObject({
        command: "echo hi",
        taskKey: "build",
        taskName: "Build",
      });
      // Begins retaining output for the run (buffer exists for the wrapper).
      expect(session.taskOutput.get(result.runId)?.result).toBe("running");
      // Records + broadcasts task.start with mode:"pane".
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId: result.runId, result: "running", mode: "pane" }),
      );
      expect(session.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "task.start",
          data: expect.objectContaining({ runId: result.runId }),
        }),
      );
    });

    it("splits a pane when target=pane", async () => {
      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp3",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build", target: "pane" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect((res.result as { paneId: string }).paneId).toBe("%split");
      expect(session.backend.terminal.runTaskInPane).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ taskKey: "build", target: "pane" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns tmux_failed when pane creation fails", async () => {
      const session = createMockSession();
      session.backend.terminal.runTaskInPane.mockRejectedValueOnce(new Error("tmux down"));
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp4",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toBe("tmux_failed");
    });

    it("errors when the task has no shell commands", async () => {
      const session = createMockSession();
      session.config.project.tasks = {
        custom: {
          name: "Custom",
          run: async () => {
            /* Noop */
          },
        },
      };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp5",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "custom" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toContain("no shell commands");
    });

    it("returns tmux_failed and finishes the run as error when terminal launch fails", async () => {
      const session = createMockSession();
      session.backend.terminal.runTaskInPane.mockImplementationOnce(async (spec) => {
        session.panesByRun.set(spec.runId, "%win");
        throw new Error("pane gone");
      });
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rp6",
        method: "tasks.runInPane",
        session: session.id,
        params: { key: "build" },
      };
      const res = await sessionHandlers["tasks.runInPane"](req, store, socket as never);
      expect(res.error).toBe("tmux_failed");
      // The stashed resolve info is cleaned up and the run is completed as error.
      const runId = [...session.paneRunInfo.keys()];
      expect(runId).toHaveLength(0);
      expect(session.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "task.complete",
          data: expect.objectContaining({ result: "error" }),
        }),
      );
    });
  });

  // ── exec-task wrapper IPC (P05-T01a) ─────────────────────────

  describe("exec-task.resolve / line / exited", () => {
    async function launchPaneRun(): Promise<{
      session: ReturnType<typeof createMockSession>;
      runId: string;
    }> {
      const session = createMockSession();
      session.config.project.tasks = { build: { name: "Build", commands: "echo hi" } };
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const res = await sessionHandlers["tasks.runInPane"](
        { id: "x", method: "tasks.runInPane", session: session.id, params: { key: "build" } },
        store,
        socket as never,
      );
      return { session, runId: (res.result as { runId: string }).runId };
    }

    it("resolves the stashed command/cwd/env for the wrapper", async () => {
      const { session, runId } = await launchPaneRun();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const res = await sessionHandlers["exec-task.resolve"](
        { id: "er1", method: "exec-task.resolve", session: session.id, params: { runId } },
        store,
        socket as never,
      );
      expect(res.result).toMatchObject({ command: "echo hi", cwd: "/fake" });
    });

    it("returns not_found for an unknown runId", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const res = await sessionHandlers["exec-task.resolve"](
        { id: "er2", method: "exec-task.resolve", session: session.id, params: { runId: "nope" } },
        store,
        socket as never,
      );
      expect(res.error).toBe("not_found");
    });

    it("appends streamed lines to the run's output buffer", async () => {
      const { session, runId } = await launchPaneRun();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      for (const line of ["building...", "done"]) {
        // eslint-disable-next-line no-await-in-loop -- ordered line delivery
        await sessionHandlers["exec-task.line"](
          { id: "el", method: "exec-task.line", session: session.id, params: { runId, line } },
          store,
          socket as never,
        );
      }
      expect(session.taskOutput.get(runId)?.lines).toEqual(["building...", "done"]);
    });

    it("completes the run on exit code 0 (success) and retains the output", async () => {
      const { session, runId } = await launchPaneRun();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      await sessionHandlers["exec-task.line"](
        { id: "el", method: "exec-task.line", session: session.id, params: { runId, line: "ok" } },
        store,
        socket as never,
      );
      const res = await sessionHandlers["exec-task.exited"](
        { id: "ee1", method: "exec-task.exited", session: session.id, params: { runId, code: 0 } },
        store,
        socket as never,
      );
      expect(res.result).toMatchObject({ ok: true });
      // Output is retrievable post-mortem with the settled result.
      expect(session.taskOutput.get(runId)).toMatchObject({
        result: "success",
        lines: ["ok"],
      });
      // The task.complete broadcast + history record carry runId + mode:pane.
      expect(session.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "task.complete",
          data: expect.objectContaining({ runId, result: "success" }),
        }),
      );
      expect(session.pushTaskRecord).toHaveBeenCalledWith(
        expect.objectContaining({ runId, result: "success", mode: "pane" }),
      );
      // The resolve entry is consumed so a re-exit is a no-op.
      expect(session.paneRunInfo.has(runId)).toBe(false);
    });

    it("completes the run as error on a non-zero exit code", async () => {
      const { session, runId } = await launchPaneRun();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      await sessionHandlers["exec-task.exited"](
        { id: "ee2", method: "exec-task.exited", session: session.id, params: { runId, code: 1 } },
        store,
        socket as never,
      );
      expect(session.taskOutput.get(runId)?.result).toBe("error");
    });

    it("is a no-op for an already-completed (or unknown) run", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const res = await sessionHandlers["exec-task.exited"](
        {
          id: "ee3",
          method: "exec-task.exited",
          session: session.id,
          params: { runId: "gone", code: 0 },
        },
        store,
        socket as never,
      );
      expect(res.result).toMatchObject({ ok: true });
      expect(session.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("tasks.output", () => {
    it("returns the retained buffer for a known runId", async () => {
      const session = createMockSession();
      session.taskOutput.start("run_x", "migrate", 1000);
      session.taskOutput.appendLines("run_x", ["line a", "line b"]);
      session.taskOutput.finish("run_x", "success", 2000);
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro1",
        method: "tasks.output",
        session: session.id,
        params: { runId: "run_x" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({
        runId: "run_x",
        taskKey: "migrate",
        result: "success",
        lines: ["line a", "line b"],
        startedAt: 1000,
        endedAt: 2000,
      });
    });

    it("returns not_found for an unknown/evicted runId", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro2",
        method: "tasks.output",
        session: session.id,
        params: { runId: "gone" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toBe("not_found");
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "ro3",
        method: "tasks.output",
        session: "unknown",
        params: { runId: "run_x" },
      };
      const res = await sessionHandlers["tasks.output"](req, store, socket as never);
      expect(res.error).toContain("Unknown session");
    });
  });

  it("validates wrapper identity before consuming replacement metadata or reporting exits", async () => {
    const session = createMockSession();
    const store = createMockStore([session]);
    const socket = createMockSocket();
    const registry = serviceWrappers(session);
    const oldId = "27eb6438-b454-42fb-97ef-210886924d5b";
    const newId = "342ac78f-e03a-4c23-a39d-2372acbf2749";
    const info = { command: "new command", cwd: "/test", env: { SECRET: "new" } };
    const exited = vi.fn();
    registry.register({ id: oldId, unitId: "dev", generation: 1 }, "dev", info, exited);
    registry.register({ id: newId, unitId: "dev", generation: 2 }, "dev", info, exited);
    for (const params of [
      { service: "dev", executionId: oldId },
      { service: "dev" },
      { service: "other", executionId: newId },
      { service: "dev", executionId: 123 },
    ]) {
      const request = { id: "stale", session: session.id, params };
      const resolve = await sessionHandlers["exec-service.resolve"](
        { ...request, method: "exec-service.resolve" },
        store,
        socket as never,
      );
      expect(resolve.error).toBeDefined();
      await sessionHandlers["exec-service.exited"](
        { ...request, method: "exec-service.exited", params: { ...params, code: 1 } },
        store,
        socket as never,
      );
      expect(exited).not.toHaveBeenCalled();
    }
    const request = {
      id: "new",
      session: session.id,
      params: { service: "dev", executionId: newId },
    };
    const resolved = await sessionHandlers["exec-service.resolve"](
      { ...request, method: "exec-service.resolve" },
      store,
      socket as never,
    );
    expect(resolved.result).toEqual(info);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await sessionHandlers["exec-service.exited"](
        { ...request, method: "exec-service.exited", params: { ...request.params, code: 1 } },
        store,
        socket as never,
      );
      expect(result.result).toEqual({ ok: true });
    }
    expect(exited).toHaveBeenCalledTimes(1);
  });

  describe("exec-service.resolve", () => {
    it("returns exec info and deletes it", async () => {
      const session = createMockSession();
      serviceWrappers(session).registerLegacy(
        "dev",
        { command: "pnpm dev", cwd: "/test", env: { DB: "x" } },
        vi.fn(),
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re1",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.result).toEqual({ command: "pnpm dev", cwd: "/test", env: { DB: "x" } });
      expect(session.execInfo.has("dev")).toBe(false);
    });

    it("returns error when no exec info exists", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re2",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.error).toContain("No exec info");
    });

    it("returns error for second resolve (one-time delete)", async () => {
      const session = createMockSession();
      serviceWrappers(session).registerLegacy(
        "dev",
        { command: "pnpm dev", cwd: "/test", env: {} },
        vi.fn(),
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re3",
        method: "exec-service.resolve",
        session: session.id,
        params: { service: "dev" },
      };
      await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      const res2 = await sessionHandlers["exec-service.resolve"](
        { ...req, id: "re4" },
        store,
        socket as never,
      );
      expect(res2.error).toContain("No exec info");
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "re5",
        method: "exec-service.resolve",
        session: "unknown",
        params: { service: "dev" },
      };
      const res = await sessionHandlers["exec-service.resolve"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("exec-service.exited", () => {
    it("calls handleExecExited with correct args", async () => {
      const session = createMockSession();
      serviceWrappers(session).registerLegacy(
        "dev",
        { command: "pnpm dev", cwd: "/test", env: {} },
        (exit) => {
          session.manager.handleExecExited("dev", exit.code, exit.signal ?? null, exit.spawnError);
        },
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx1",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 1, signal: "SIGTERM" },
      };
      const res = await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(res.result).toEqual({ ok: true });
      expect(session.manager.handleExecExited).toHaveBeenCalledWith("dev", 1, "SIGTERM", undefined);
    });

    it("defaults null signal when omitted", async () => {
      const session = createMockSession();
      serviceWrappers(session).registerLegacy(
        "dev",
        { command: "pnpm dev", cwd: "/test", env: {} },
        (exit) => {
          session.manager.handleExecExited("dev", exit.code, exit.signal ?? null, exit.spawnError);
        },
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx2",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 0 },
      };
      await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(session.manager.handleExecExited).toHaveBeenCalledWith("dev", 0, null, undefined);
    });

    it("forwards spawnError to handleExecExited", async () => {
      const session = createMockSession();
      serviceWrappers(session).registerLegacy(
        "dev",
        { command: "pnpm dev", cwd: "/test", env: {} },
        (exit) => {
          session.manager.handleExecExited("dev", exit.code, exit.signal ?? null, exit.spawnError);
        },
      );
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx3",
        method: "exec-service.exited",
        session: session.id,
        params: { service: "dev", code: 127, signal: null, spawnError: "spawn cwd ENOENT" },
      };
      await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(session.manager.handleExecExited).toHaveBeenCalledWith(
        "dev",
        127,
        null,
        "spawn cwd ENOENT",
      );
    });

    it("returns error for unknown session", async () => {
      const store = createMockStore();
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "rx3",
        method: "exec-service.exited",
        session: "unknown",
        params: { service: "dev", code: 1 },
      };
      const res = await sessionHandlers["exec-service.exited"](req, store, socket as never);
      expect(res.error).toBe("Unknown session");
    });
  });

  describe("logs.snapshot", () => {
    it("returns log buffer snapshot", async () => {
      const session = createMockSession();
      const buf = session.logBuffers.get("api");
      buf?.append("line1");
      buf?.append("line2");
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r26",
        method: "logs.snapshot",
        session: session.id,
        params: { service: "api" },
      };
      const res = await sessionHandlers["logs.snapshot"](req, store, socket as never);
      expect(res.result).toEqual(["line1", "line2"]);
    });

    it("returns error for unknown service", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const socket = createMockSocket();
      const req: IpcRequest = {
        id: "r27",
        method: "logs.snapshot",
        session: session.id,
        params: { service: "unknown" },
      };
      const res = await sessionHandlers["logs.snapshot"](req, store, socket as never);
      expect(res.error).toContain("Unknown service");
    });
  });

  describe("task sentra env", () => {
    function sentraSession(available = true) {
      const sentra = fakeSentra(available);
      const session = createMockSession({
        deps: { zapsCommand: "zaps", sessionId: "abc123", sentra },
      });
      session.config.project.sentra = SENTRA_BLOCK;
      session.config.project.tasks = {
        e2e: { name: "E2E", commands: "pnpm e2e", sentra: true },
        lint: { name: "Lint", popup: true, commands: ["eslint ."], sentra: true },
      };
      return { session, sentra };
    }

    async function runInPane(session: ReturnType<typeof createMockSession>) {
      const res = await sessionHandlers["tasks.runInPane"](
        { id: "s1", method: "tasks.runInPane", session: session.id, params: { key: "e2e" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      const { runId } = res.result as { runId: string };
      return session.paneRunInfo.get(runId);
    }

    it("injects the DSN into pane runs below the task env", async () => {
      const { resolveEnv } = (await import("../../../src/lib/service/env.js")) as unknown as {
        resolveEnv: ReturnType<typeof vi.fn>;
      };
      resolveEnv.mockReturnValueOnce({ SHARED: "task" });
      const { session, sentra } = sentraSession();

      const info = await runInPane(session);

      expect(sentra.host.getDsn).toHaveBeenCalledWith(expect.objectContaining({ service: "e2e" }));
      expect(info?.env).toEqual({ SENTRY_DSN: fakeSentraDsn("e2e"), SHARED: "task" });
    });

    it("runs pane tasks without sentra env when the host is unavailable", async () => {
      const { session, sentra } = sentraSession(false);

      const info = await runInPane(session);

      expect(info?.env).not.toHaveProperty("SENTRY_DSN");
      expect(sentra.log).toHaveBeenCalledWith(
        "sentra: e2e runs without Sentra env (port bind failed)",
      );
    });

    it.each([true, false])("injects Sentra into background popup=%s runs", async (popup) => {
      const { session, execute } = taskSession({
        lint: { name: "Lint", popup, commands: "eslint .", sentra: true },
      });
      const sentra = fakeSentra();
      session.config.project.sentra = SENTRA_BLOCK;
      session.taskExecution = new TaskExecutionService(
        {
          id: session.id,
          config: session.config,
          env: session.env,
          manager: {
            startService: async () => ({ noop: false }),
            restartService: async () => {
              /* Noop */
            },
            stopService: async () => ({ noop: false }),
            getAllStatuses: () => [createServiceStatus("api")],
          },
          deps: { sentra },
          broadcast: (event) => {
            session.broadcast(event);
          },
        },
        () => ({ execute }),
      );
      taskOwners.push(session.taskExecution);
      await sessionHandlers["tasks.run"](
        { id: "s2", method: "tasks.run", session: session.id, params: { key: "lint" } },
        createMockStore([session]),
        createMockSocket() as never,
      );
      expect(execute).toHaveBeenCalledWith(
        "eslint .",
        expect.objectContaining({
          env: expect.objectContaining({ SENTRY_DSN: fakeSentraDsn("lint") }),
        }),
      );
    });
  });
});

describe("terminal.action", () => {
  function fixture() {
    const socket = new Socket();
    const session = createMockSession();
    const binding = {
      acknowledged: true,
      socket,
      sessionId: session.id,
      socketId: "binding",
      controller: new AbortController(),
    };
    const terminal = {
      ...session.backend.terminal,
      focus: vi.fn<TerminalDriver["focus"]>().mockResolvedValue(undefined),
      zoom: vi.fn<TerminalDriver["zoom"]>().mockResolvedValue(undefined),
      editOutput: vi.fn<TerminalDriver["editOutput"]>().mockResolvedValue(undefined),
      taskPicker: vi.fn<TerminalDriver["taskPicker"]>().mockResolvedValue(null),
      taskOutput: vi.fn<TerminalDriver["taskOutput"]>().mockResolvedValue(undefined),
    } satisfies TerminalDriver;
    const capabilities: Record<keyof BackendCapabilities, boolean> = {
      panes: true,
      zoom: true,
      popups: true,
      taskPanes: true,
      rawInput: true,
      layout: true,
    };
    const view = {
      kind: "tmux",
      tmuxSession: session.tmuxSession,
      tmuxWindow: "window",
      originPane: session.originPane,
      tmuxSocket: session.tmuxSocket,
      managedTmux: session.managedTmux,
      paneMap: session.paneMap,
    } satisfies PresentationSnapshot;
    const backend = {
      id: "tmux",
      terminal,
      capabilities,
      getPresentation: vi.fn<SessionBackend["getPresentation"]>(() => view),
    } satisfies Pick<SessionBackend, "id" | "terminal" | "capabilities" | "getPresentation">;
    const full = Object.assign(session, {
      env: { TOKEN: "service" },
      taskExecution: { accepting: true },
      getUiBinding: vi.fn<() => UiBinding | undefined>(() => binding),
      backend,
    });
    const store = createMockStore([full]);
    const invoke = async (params: unknown, context?: IpcRequest["context"]) =>
      sessionHandlers["terminal.action"](
        { id: "terminal", method: "terminal.action", session: session.id, params, context },
        store,
        socket,
      );
    return { socket, binding, terminal, capabilities, full, invoke, view };
  }

  it.each([
    { action: "focus", target: { kind: "pane", id: "%2" } },
    { action: "zoom", target: { kind: "dashboard", client: "other" } },
    { action: "editOutput", service: "api", editor: "bad" },
    { action: "taskPicker", command: "bad" },
    { action: "taskOutput", runId: "run", socket: "other" },
    { action: "focus", target: { kind: "service", name: "unknown" } },
    { action: "taskOutput", runId: "unknown" },
  ])("rejects invalid targets/extra arguments %j", async (params) => {
    const f = fixture();
    expect(await f.invoke(params)).toMatchObject({ errorCode: "invalid_request" });
    expect(f.terminal.focus).not.toHaveBeenCalled();
    expect(f.terminal.taskOutput).not.toHaveBeenCalled();
  });

  it("requires the actual active binding and admission", async () => {
    const f = fixture();
    f.full.getUiBinding.mockReturnValueOnce(undefined);
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "invalid_request",
    });
    f.binding.acknowledged = false;
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "invalid_request",
    });
    f.binding.acknowledged = true;
    f.binding.sessionId = "other";
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "invalid_request",
    });
    f.binding.sessionId = f.full.id;
    f.binding.controller.abort();
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "invalid_request",
    });
    f.full.taskExecution.accepting = false;
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "session_closing",
    });
    expect(f.terminal.taskPicker).not.toHaveBeenCalled();
  });

  it("rejects unsupported capabilities and absent presentations", async () => {
    const f = fixture();
    f.capabilities.popups = false;
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      errorCode: "unsupported_capability",
    });
    f.capabilities.zoom = false;
    expect(await f.invoke({ action: "zoom", target: { kind: "dashboard" } })).toMatchObject({
      errorCode: "unsupported_capability",
    });
    f.view.paneMap = {};
    expect(
      await f.invoke({ action: "focus", target: { kind: "service", name: "api" } }),
    ).toMatchObject({ errorCode: "unsupported_capability" });
  });

  it.each(["taskPicker", "taskOutput"] as const)(
    "supports popup-only %s after UI acknowledgement without service panes",
    async (action) => {
      const f = fixture();
      Object.assign(f.capabilities, {
        panes: false,
        zoom: false,
        taskPanes: false,
        rawInput: false,
        layout: false,
      });
      f.view.paneMap = {};
      f.full.taskOutput.start("retained", "build", 1);
      const params = action === "taskPicker" ? { action } : { action, runId: "retained" };
      f.binding.acknowledged = false;
      expect(await f.invoke(params)).toMatchObject({ errorCode: "invalid_request" });
      expect(f.terminal[action]).not.toHaveBeenCalled();
      f.binding.acknowledged = true;
      expect(await f.invoke(params)).toMatchObject({
        result: action === "taskPicker" ? { action, taskKey: null } : { action, done: true },
      });
      expect(f.terminal[action]).toHaveBeenCalledTimes(1);
      expect(f.full.backend.getPresentation).not.toHaveBeenCalled();
      if (action === "taskOutput") {
        expect(await f.invoke({ action, runId: "unknown" })).toMatchObject({
          errorCode: "invalid_request",
        });
        expect(f.terminal.taskOutput).toHaveBeenCalledTimes(1);
      }
      f.capabilities.popups = false;
      expect(await f.invoke(params)).toMatchObject({ errorCode: "unsupported_capability" });
      expect(f.terminal[action]).toHaveBeenCalledTimes(1);
      expect(f.full.manager.startService).not.toHaveBeenCalled();
    },
  );

  it("keeps pane controls unavailable with popup-only capabilities", async () => {
    const f = fixture();
    f.capabilities.panes = false;
    for (const params of [
      { action: "focus", target: { kind: "dashboard" } },
      { action: "zoom", target: { kind: "dashboard" } },
      { action: "editOutput", service: "api" },
    ]) {
      expect(await f.invoke(params)).toMatchObject({ errorCode: "unsupported_capability" });
    }
    expect(f.terminal.focus).not.toHaveBeenCalled();
    expect(f.terminal.zoom).not.toHaveBeenCalled();
    expect(f.terminal.editOutput).not.toHaveBeenCalled();
  });

  it("preserves busy/unavailable and returns cancelled picker without running a task", async () => {
    const f = fixture();
    for (const code of ["terminal_busy", "backend_unavailable"] as const) {
      f.terminal.taskPicker.mockRejectedValueOnce(new TerminalOperationError(code));
      expect(await f.invoke({ action: "taskPicker" })).toMatchObject({ errorCode: code });
    }
    expect(await f.invoke({ action: "taskPicker" })).toMatchObject({
      result: { action: "taskPicker", taskKey: null },
    });
    expect(f.full.manager.startService).not.toHaveBeenCalled();
  });

  it("keeps operation environment/cwd isolated from later service calls", async () => {
    const f = fixture();
    const context = {
      cwd: "/caller",
      env: { EDITOR: "editor --wait", PATH: "/caller/bin", TOKEN: "popup" },
    };
    expect(await f.invoke({ action: "editOutput", service: "api" }, context)).toMatchObject({
      result: { action: "editOutput", done: true },
    });
    expect(f.terminal.editOutput).toHaveBeenCalledWith("api", {
      id: "binding",
      ...context,
      signal: f.binding.controller.signal,
    });
    expect(f.full.env).toEqual({ TOKEN: "service" });
  });

  it("displays retained output without starting a new run", async () => {
    const f = fixture();
    f.full.taskOutput.start("run", "build", 1);
    expect(await f.invoke({ action: "taskOutput", runId: "run" })).toMatchObject({
      result: { action: "taskOutput", done: true },
    });
    expect(f.terminal.taskOutput).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({ id: "binding" }),
    );
    expect(f.full.taskOutput.get("run")?.lines).toEqual([]);
  });
});

describe("bound host detach", () => {
  function fixture(managedTmux = true, shell = false) {
    const socket = new Socket();
    const session = createMockSession();
    const binding: UiBinding = {
      acknowledged: true,
      socket,
      sessionId: session.id,
      socketId: "detach",
      controller: new AbortController(),
    };
    const detachHost = vi.fn(async () => undefined);
    const full = Object.assign(session, {
      env: {},
      getUiBinding: vi.fn<() => UiBinding | undefined>(() => binding),
      removeSubscriber: vi.fn(),
      backend: {
        terminal: shell ? undefined : { detachHost },
        getPresentation: () => (shell ? { kind: "shell" } : { kind: "tmux", managedTmux }),
      },
    });
    const invoke = async (params: unknown = { detachHost: true }) =>
      sessionHandlers["session.detach"](
        { id: "detach", method: "session.detach", session: session.id, params },
        createMockStore([full]),
        socket,
      );
    return { full, socket, binding, detachHost, invoke };
  }

  it.each([undefined, { detachHost: false }])(
    "keeps unsubscribe-only behavior %j",
    async (params) => {
      const f = fixture();
      expect(await f.invoke(params ?? {})).toMatchObject({ result: { detached: true } });
      expect(f.detachHost).not.toHaveBeenCalled();
      expect(f.full.removeSubscriber).toHaveBeenCalledWith(f.socket);
    },
  );

  it("awaits host detach before releasing the binding", async () => {
    const f = fixture();
    f.detachHost.mockImplementation(async () => {
      expect(f.full.removeSubscriber).not.toHaveBeenCalled();
    });
    expect(await f.invoke()).toMatchObject({ result: { detached: true } });
    expect(f.detachHost).toHaveBeenCalledTimes(1);
    expect(f.full.removeSubscriber).toHaveBeenCalledWith(f.socket);
  });

  it.each([
    "unbound",
    "unacknowledged",
    "closing",
    "closed",
    "caller-target",
    "failure",
    "late-close",
  ])("preserves subscription on %s", async (mode) => {
    const f = fixture();
    if (mode === "unbound") {
      f.full.getUiBinding.mockReturnValue(undefined);
    }
    if (mode === "unacknowledged") {
      f.binding.acknowledged = false;
    }
    if (mode === "closing") {
      f.full.taskExecution.accepting = false;
    }
    if (mode === "closed") {
      f.socket.destroy();
    }
    if (mode === "failure") {
      f.detachHost.mockRejectedValue(new Error("ambiguous"));
    }
    if (mode === "late-close") {
      f.detachHost.mockImplementation(async () => {
        f.binding.controller.abort();
      });
    }
    const response = await f.invoke(
      mode === "caller-target" ? { detachHost: true, client: "other" } : { detachHost: true },
    );
    expect(response.error).toBeDefined();
    expect(f.full.removeSubscriber).not.toHaveBeenCalled();
  });

  it.each(["success", "moved", "close-failed"])(
    "task popup detach %s preserves binding until success",
    async (mode) => {
      const f = fixture();
      const client = {
        name: "/dev/pts/42",
        pid: 42,
        sessionId: "$1",
        sessionName: "owned",
        windowId: "@2",
      };
      let finishPopup: () => void = vi.fn();
      const popup = new Promise<void>((resolve) => {
        finishPopup = resolve;
      });
      const tmux = {
        getSocket: () => "detach-task",
        listClients: vi.fn(async () => [{ ...client }]),
        displayMessage: vi.fn(async () => "$1\towned\t@2"),
        displayPopup: vi.fn(async () => popup),
        closePopup: vi.fn(async () => {
          if (mode === "close-failed") {
            throw new Error("close failed");
          }
          if (mode === "moved") {
            tmux.listClients.mockResolvedValue([{ ...client, windowId: "@other" }]);
          }
        }),
        capturePaneHistory: vi.fn(async () => ""),
        detachClient: vi.fn(async () => undefined),
      } satisfies OperationTmux;
      const operations = new TmuxTerminalOperations(
        tmux,
        "owned",
        "%3",
        new TmuxTerminalLeaseRegistry(),
      );
      const taskController = new AbortController();
      const run = operations.run(
        {
          owner: { kind: "task", sessionId: f.full.id, runId: "hook" },
          cwd: "/project",
          env: {},
          signal: taskController.signal,
        },
        async (context) => {
          await context.popup({ command: "hook" });
        },
      );
      const result = (async () => {
        try {
          return await run;
        } catch (error) {
          return error;
        }
      })();
      await vi.waitFor(() => expect(tmux.displayPopup).toHaveBeenCalledTimes(1));
      f.detachHost.mockImplementation(async () => {
        await operations.detachHost(
          { kind: "ui", sessionId: f.full.id, socketId: f.binding.socketId },
          () => !f.binding.controller.signal.aborted,
        );
      });
      const response = await f.invoke();
      if (mode === "success") {
        expect(response).toMatchObject({ result: { detached: true } });
        expect(f.full.removeSubscriber).toHaveBeenCalledWith(f.socket);
        expect(tmux.detachClient).toHaveBeenCalledExactlyOnceWith(client.name);
      } else {
        expect(response).toMatchObject({ errorCode: "backend_unavailable" });
        expect(f.full.removeSubscriber).not.toHaveBeenCalled();
        expect(f.full.getUiBinding()).toBe(f.binding);
        expect(f.binding.controller.signal.aborted).toBe(false);
        expect(tmux.detachClient).not.toHaveBeenCalled();
      }
      expect(await result).toMatchObject({
        code: mode === "close-failed" ? "terminal_busy" : "cancelled",
      });
      expect(taskController.signal.aborted).toBe(false);
      expect(tmux.closePopup).toHaveBeenCalledExactlyOnceWith(client.name);
      finishPopup();
      await operations.dispose();
      expect(tmux.displayPopup).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [false, false],
    [true, true],
  ])("personal/no-terminal only unsubscribe %j", async (managed, shell) => {
    const f = fixture(managed, shell);
    expect(await f.invoke()).toMatchObject({ result: { detached: true } });
    expect(f.detachHost).not.toHaveBeenCalled();
    expect(f.full.removeSubscriber).toHaveBeenCalledWith(f.socket);
  });
});
