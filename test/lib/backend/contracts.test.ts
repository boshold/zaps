import { Socket } from "node:net";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig } from "#src/config/types.js";
import { sessionHandlers } from "#src/daemon/handlers/session.js";
import { Session } from "#src/daemon/session.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import {
  backendCapabilitiesSchema,
  backendIdSchema,
  backendMetadataSchema,
  executionEventSchema,
  ipcErrorResponseSchema,
  normalizeLegacySessionCreateParams,
  presentationSnapshotSchema,
  sessionCreateParamsSchema,
  sessionCreatedSchema,
  sessionListEntrySchema,
} from "#src/lib/backend/schemas.js";
import { ShellSessionBackend } from "#src/lib/backend/shell/session.js";
import { TmuxRuntime, WrapperRegistry } from "#src/lib/backend/tmux/runtime.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type {
  BackendCapabilities,
  BackendId,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
  SessionBackend,
  TerminalDriver,
} from "#src/lib/backend/types.js";
import { captureEnvironment } from "#src/lib/request-context.js";
import { shellEscape } from "#src/lib/service/env.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceManagerDeps } from "#src/lib/service/manager.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { createMockStore } from "../../_helpers/mock-session.js";

vi.mock("#src/config/project-context.js", () => ({ loadProjectContext: vi.fn() }));

const mixedCapabilities: BackendCapabilities = {
  panes: true,
  taskPanes: true,
  zoom: false,
  popups: false,
  rawInput: false,
  layout: false,
};
const shellCapabilities: BackendCapabilities = {
  panes: false,
  taskPanes: false,
  zoom: false,
  popups: false,
  rawInput: false,
  layout: false,
};

function createCollaborators() {
  const executions = new Map<string, ExecutionSpec>();
  const listeners = new Set<(event: ExecutionEvent) => void>();
  let nextId = 0;
  const runtime: RuntimeDriver = {
    closeAdmission: vi.fn(),
    async start(spec) {
      nextId += 1;
      const handle: ExecutionHandle = {
        id: `private execution ${nextId}`,
        unitId: spec.unitId,
        generation: spec.generation,
      };
      executions.set(handle.id, spec);
      return handle;
    },
    async stop(handle) {
      executions.delete(handle.id);
    },
    async isRunning(handle) {
      return executions.has(handle.id);
    },
    async getPid() {
      return undefined;
    },
    async readOutput() {
      return [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const terminal: TerminalDriver = {
    reconcileLayout: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    zoom: vi.fn(async () => undefined),
    editOutput: vi.fn(async () => undefined),
    taskPicker: vi.fn(async () => null),
    taskOutput: vi.fn(async () => undefined),
    runTaskInPane: vi.fn(async (spec) => runtime.start(spec.execution)),
  };
  return {
    runtime,
    terminal,
    capabilities: mixedCapabilities,
    emit(event: ExecutionEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

const common = { configPath: "/project/.zaps.mts", projectDir: "/project" };
const tmuxCreate = { ...common, backend: "tmux", tmuxSession: "project", originPane: "%1" };

describe("backend contracts", () => {
  it("keeps only built-in IDs while allowing independent mixed capabilities", () => {
    expectTypeOf<BackendId>().toEqualTypeOf<"tmux" | "shell">();
    expect(backendIdSchema.options).toEqual(["tmux", "shell"]);
    expect(backendIdSchema.safeParse("fixture").success).toBe(false);
    expect(backendCapabilitiesSchema.parse(mixedCapabilities)).toEqual(mixedCapabilities);
    expect(
      backendCapabilitiesSchema.safeParse({ ...mixedCapabilities, zoom: "false" }).success,
    ).toBe(false);
    expect(backendCapabilitiesSchema.safeParse({ panes: true }).success).toBe(false);
  });

  it("parses strict backend metadata without deriving capabilities from the ID", () => {
    expect(
      backendMetadataSchema.parse({ backend: "tmux", capabilities: mixedCapabilities })
        .capabilities,
    ).toEqual(mixedCapabilities);
    expect(
      backendMetadataSchema.parse({ backend: "shell", capabilities: shellCapabilities }).backend,
    ).toBe("shell");
    expect(
      backendMetadataSchema.safeParse({ backend: "other", capabilities: mixedCapabilities })
        .success,
    ).toBe(false);
    expect(
      backendMetadataSchema.safeParse({ backend: "shell", capabilities: mixedCapabilities })
        .success,
    ).toBe(false);
    expect(
      backendMetadataSchema.safeParse({
        backend: "shell",
        capabilities: shellCapabilities,
        tmuxSession: "project",
      }).success,
    ).toBe(false);
  });

  it("validates creation ownership and rejects every tmux field in shell creation", () => {
    expect(sessionCreateParamsSchema.parse(tmuxCreate)).toEqual(tmuxCreate);
    expect(sessionCreateParamsSchema.parse({ ...tmuxCreate, tmuxSocket: null }).backend).toBe(
      "tmux",
    );
    expect(
      sessionCreateParamsSchema.parse({ ...tmuxCreate, managedTmux: true, tmuxSocket: "owned" })
        .backend,
    ).toBe("tmux");
    expect(sessionCreateParamsSchema.parse({ ...common, backend: "shell" }).backend).toBe("shell");
    for (const tmuxFields of [
      { tmuxSession: "project" },
      { originPane: "%1" },
      { tmuxSocket: null },
      { managedTmux: false },
    ]) {
      expect(
        sessionCreateParamsSchema.safeParse({ ...common, backend: "shell", ...tmuxFields }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...tmuxCreate, managedTmux: true },
      { ...tmuxCreate, managedTmux: true, tmuxSocket: null },
      { ...tmuxCreate, tmuxSocket: " " },
      { ...tmuxCreate, originPane: "" },
      { ...common, backend: "unknown" },
    ]) {
      expect(sessionCreateParamsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes only explicitly legacy creation requests", () => {
    const legacy = { ...common, tmuxSession: "project", originPane: "%1" };
    expect(sessionCreateParamsSchema.safeParse(legacy).success).toBe(false);
    expect(normalizeLegacySessionCreateParams(legacy)).toEqual(tmuxCreate);
    expect(() => normalizeLegacySessionCreateParams({ ...legacy, backend: "other" })).toThrow();
    expect(() => normalizeLegacySessionCreateParams({ ...legacy, backend: undefined })).toThrow();
    expect(() => normalizeLegacySessionCreateParams(null)).toThrow();
  });

  it("keeps shell responses free of terminal projections", () => {
    const shell = {
      id: "session",
      name: "project",
      backend: "shell",
      capabilities: shellCapabilities,
    };
    expect(sessionCreatedSchema.parse({ ...shell, paneMap: {} })).toEqual({
      ...shell,
      paneMap: {},
    });
    expect(
      sessionCreatedSchema.safeParse({ ...shell, paneMap: { api: "private target" } }).success,
    ).toBe(false);
    expect(
      sessionCreatedSchema.safeParse({ ...shell, paneMap: {}, focusPane: "private target" })
        .success,
    ).toBe(false);
    const list = { ...shell, ...common, createdAt: 1 };
    expect(sessionListEntrySchema.parse(list)).toEqual(list);
    for (const fields of [{ tmuxSession: "project" }, { managed: false }, { tuiPane: null }]) {
      expect(sessionListEntrySchema.safeParse({ ...list, ...fields }).success).toBe(false);
    }
    const tmux = { ...shell, backend: "tmux", capabilities: mixedCapabilities };
    expect(
      sessionCreatedSchema.parse({ ...tmux, paneMap: { api: "%2" }, focusPane: "%2" }),
    ).toMatchObject({ focusPane: "%2" });
    expect(
      sessionListEntrySchema.parse({
        ...list,
        ...tmux,
        tmuxSession: "project",
        managed: true,
        tuiPane: null,
      }).backend,
    ).toBe("tmux");
    expect(presentationSnapshotSchema.parse({ kind: "shell" })).toEqual({ kind: "shell" });
    expect(
      presentationSnapshotSchema.parse({
        kind: "tmux",
        tmuxSession: "project",
        tmuxWindow: "@1",
        originPane: "%1",
        tmuxSocket: null,
        managedTmux: false,
        paneMap: {},
      }).kind,
    ).toBe("tmux");
  });

  it("separates immediate leader exit from final cleanup and output events", () => {
    const identity = { unitId: "api", generation: 2 };
    const details = { code: null, signal: "SIGTERM", spawnError: "spawn failed" };
    for (const event of [
      { ...identity, ...details, kind: "leaderExit" },
      { ...identity, kind: "output", lines: ["ready"] },
      { ...identity, ...details, kind: "exit", cleanupError: "group remains", drainTimedOut: true },
    ]) {
      expect(executionEventSchema.parse(event)).toEqual(event);
    }
    expect(
      executionEventSchema.safeParse({
        ...identity,
        ...details,
        kind: "leaderExit",
        cleanupError: "too early",
      }).success,
    ).toBe(false);
    expect(
      executionEventSchema.safeParse({
        ...identity,
        ...details,
        kind: "exit",
        drainTimedOut: "true",
      }).success,
    ).toBe(false);
    expect(
      executionEventSchema.safeParse({ ...identity, kind: "output", generation: -1, lines: [] })
        .success,
    ).toBe(false);
  });

  it("retains legacy error strings with optional typed codes", () => {
    expect(ipcErrorResponseSchema.parse({ id: "request", error: "failed" })).toEqual({
      id: "request",
      error: "failed",
    });
    expect(
      ipcErrorResponseSchema.parse({ id: "request", error: "busy", errorCode: "terminal_busy" })
        .errorCode,
    ).toBe("terminal_busy");
    expect(
      ipcErrorResponseSchema.safeParse({ id: "request", error: "failed", errorCode: "unknown" })
        .success,
    ).toBe(false);
  });

  it("injects runtime and optional terminal collaborators using opaque private IDs", async () => {
    function inject(runtime: RuntimeDriver, terminal?: TerminalDriver) {
      return { runtime, terminal };
    }
    const fixture = createCollaborators();
    const dependencies = inject(fixture.runtime, fixture.terminal);
    expect(inject(fixture.runtime).terminal).toBeUndefined();
    const eventListener = vi.fn<(event: ExecutionEvent) => void>();
    const unsubscribe = dependencies.runtime.subscribe(eventListener);
    const spec: ExecutionSpec = {
      unitId: "api",
      generation: 1,
      command: "run api",
      cwd: "/project",
      env: {},
      placement: "background",
      raw: false,
    };
    const handle = await dependencies.runtime.start(spec);
    expect(handle).toEqual({ id: "private execution 1", unitId: "api", generation: 1 });
    expect(await dependencies.runtime.isRunning(handle)).toBe(true);
    await dependencies.terminal?.focus({ kind: "service", name: "api" });
    expect(fixture.terminal.focus).toHaveBeenCalledWith({ kind: "service", name: "api" });
    const event: ExecutionEvent = {
      kind: "output",
      unitId: handle.unitId,
      generation: handle.generation,
      lines: ["ready"],
    };
    fixture.emit(event);
    expect(eventListener).toHaveBeenCalledExactlyOnceWith(event);
    unsubscribe();
    fixture.emit(event);
    expect(eventListener).toHaveBeenCalledTimes(1);
    await dependencies.runtime.stop(handle);
    expect(await dependencies.runtime.isRunning(handle)).toBe(false);
    expect(fixture.capabilities).toEqual(mixedCapabilities);
  });
});

function lifecycleConfig(command: string): ResolvedConfig {
  return {
    project: {
      name: "contracts",
      services: {
        worker: {
          start: command,
          detached: true,
          url: false,
          ready: { output: /CONTRACT_READY/u },
        },
      },
    },
    configPath: "/contract/.zaps.mts",
    projectDir: process.cwd(),
    groups: new Map(),
    unavailableServices: new Map(),
    lazyPaneByService: new Map(),
  };
}

async function lifecycleBackend(kind: "shell" | "tmux" | "mixed", config: ResolvedConfig) {
  const forbidden = vi.fn(async () => {
    throw new Error("Unsupported terminal method invoked");
  });
  const terminal: TerminalDriver = {
    reconcileLayout: forbidden,
    focus: forbidden,
    zoom: forbidden,
    editOutput: forbidden,
    taskPicker: forbidden,
    taskOutput: forbidden,
    runTaskInPane: forbidden,
  };
  if (kind !== "tmux") {
    const shell = await ShellSessionBackend.create({ services: config.project.services });
    const backend: SessionBackend =
      kind === "shell"
        ? shell
        : {
            id: "tmux",
            capabilities: mixedCapabilities,
            runtime: shell.runtime,
            terminal,
            getPresentation: () => ({
              kind: "tmux",
              tmuxSession: "private host",
              tmuxWindow: "opaque/window",
              originPane: "opaque/dashboard",
              tmuxSocket: null,
              managedTmux: false,
              paneMap: { worker: "opaque/service" },
            }),
            subscribePresentation: () => () => undefined,
            health: async () => shell.health(),
            dispose: async () => shell.dispose(),
          };
    return { backend, forbidden };
  }
  const processes = new ProcessRunner({ onLines: () => undefined, onExit: () => undefined });
  const tmux = {
    ...tmuxFor(null),
    resyncPaneSizes: vi.fn(async () => undefined),
    selectPane: vi.fn(async () => undefined),
    hasSession: vi.fn(async () => true),
    paneExists: vi.fn(async () => true),
    displayMessage: vi.fn(async () => "0"),
  };
  const runtime = new TmuxRuntime({
    tmux,
    processes,
    sessionId: "contract",
    zapsCommand: "unused",
    wrappers: new WrapperRegistry(),
    paneFor: () => {
      throw new Error("Background contract requested a pane");
    },
  });
  const backend = await TmuxSessionBackend.create({
    tmux,
    runtime,
    disposeRuntime: async () => runtime.dispose(),
    terminal,
    host: {
      tmuxSession: "contract",
      tmuxWindow: "@1",
      originPane: "%1",
      tmuxSocket: null,
      managedTmux: false,
    },
    services: config.project.services,
  });
  return { backend, forbidden };
}

describe.each(["shell", "tmux", "mixed"] as const)("shared %s backend lifecycle", (kind) => {
  it("preserves shared readiness, output, restart, reload and cleanup policies", async () => {
    const payload =
      'console.log("CONTRACT_READY");setInterval(()=>console.log("CONTRACT_LATER"),30)';
    const config = lifecycleConfig(`${shellEscape(process.execPath)} -e ${shellEscape(payload)}`);
    const { backend, forbidden } = await lifecycleBackend(kind, config);
    const handles: ExecutionHandle[] = [];
    const original = backend.runtime.start.bind(backend.runtime);
    vi.spyOn(backend.runtime, "start").mockImplementation(async (spec) => {
      const handle = await original(spec);
      handles.push(handle);
      return handle;
    });
    const deps: ServiceManagerDeps = {
      runtime: backend.runtime,
      sessionId: "contract",
      zapsCommand: "unused",
      hasPresentation: () => false,
      inspectPorts: async () => [],
      exec: async () => undefined,
      preflightPorts: async () => null,
      reflowInsert: async () => undefined,
      reflowRemove: async () => undefined,
    };
    const manager = new ServiceManager(config, deps);
    const session = new Session(
      {
        backend,
        config,
        configPath: config.configPath,
        projectDir: config.projectDir,
        deps,
        shellEnv: captureEnvironment(),
        env: captureEnvironment(),
      },
      manager,
    );
    const socket = new Socket();
    vi.spyOn(socket, "write").mockReturnValue(true);
    const store = createMockStore();
    store.get = (id) => (id === session.id ? session : undefined);
    try {
      await session.startAll();
      expect(session.manager.getStatus("worker").state).toBe("ready");
      await vi.waitFor(() =>
        expect(session.logBuffers.get("worker")?.snapshot()).toContain("CONTRACT_LATER"),
      );
      const [first] = handles;
      if (!first) {
        throw new Error("Missing first execution");
      }
      expect(await backend.runtime.isRunning(first)).toBe(true);
      await session.manager.restartService("worker");
      expect(handles[1]?.id).not.toBe(first.id);
      expect(handles[1]?.generation).toBe(2);
      expect(await backend.runtime.isRunning(first)).toBe(false);
      vi.mocked(loadProjectContext).mockResolvedValue({ config, env: captureEnvironment() });
      await session.reload();
      await session.startPromise;
      expect(session.manager).not.toBe(manager);
      expect(handles).toHaveLength(3);
      expect(session.manager.getStatus("worker").state).toBe("ready");
      await vi.waitFor(() =>
        expect(session.logBuffers.get("worker")?.snapshot()).toContain("CONTRACT_LATER"),
      );
      if (!backend.capabilities.zoom || !backend.capabilities.popups) {
        session.addSubscriber(socket);
        session.subscriberAcknowledgement(socket)();
        session.bindUi(socket);
        session.uiBindingAcknowledgement(socket)();
        const response = await sessionHandlers["terminal.action"](
          {
            id: "unsupported",
            method: "terminal.action",
            session: session.id,
            params: { action: "zoom", target: { kind: "dashboard" } },
          },
          store,
          socket,
        );
        expect(response).toMatchObject({ errorCode: "unsupported_capability" });
      }
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
      socket.destroy();
    }
    for (const handle of handles) {
      expect(await backend.runtime.isRunning(handle)).toBe(false);
    }
    await expect(
      backend.runtime.start({
        unitId: "late",
        generation: 1,
        command: "true",
        cwd: process.cwd(),
        env: {},
        placement: "background",
        raw: false,
      }),
    ).rejects.toThrow("closing");
  });
});
