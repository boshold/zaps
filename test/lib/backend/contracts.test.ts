import { describe, expect, expectTypeOf, it, vi } from "vitest";

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
import type {
  BackendCapabilities,
  BackendId,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
  TerminalDriver,
} from "#src/lib/backend/types.js";

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
