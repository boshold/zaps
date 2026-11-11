import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceConfig } from "#src/config/types.js";
import { preflightBackendCompatibility } from "#src/lib/backend/compatibility.js";
import { backendFactories, createSessionBackend } from "#src/lib/backend/factory.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { ShellSessionBackend, shellCapabilities } from "#src/lib/backend/shell/session.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { ExecutionEvent, ExecutionSpec, SessionBackend } from "#src/lib/backend/types.js";
// oxlint-disable-next-line import/no-namespace
import * as tmuxModule from "#src/lib/tmux.js";

const spec: ExecutionSpec = {
  unitId: "worker",
  generation: 3,
  command: "payload",
  cwd: process.cwd(),
  env: {},
  placement: "default",
  raw: false,
};

function deferred() {
  let complete: (() => void) | undefined;
  let fail: ((reason: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: () => complete?.(), reject: (reason: Error) => fail?.(reason) };
}

function pendingProcess() {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const gate = new PassThrough();
  const identity: ProcessIdentity = { pid: 4242, startTime: "birth", pgid: 4242, sid: "abcd" };
  const live = new Map([[identity.pid, identity]]);
  Object.defineProperties(child, {
    pid: { value: identity.pid },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [null, stdout, stderr, gate] },
  });
  const record = deferred();
  const recorded = vi.fn(async () => record.promise);
  const unrecord = vi.fn(() => {
    stdout.destroy();
    stderr.destroy();
  });
  const kill = vi.fn((pid: number) => {
    live.delete(pid);
  });
  return {
    child,
    gate,
    live,
    record,
    recorded,
    unrecord,
    kill,
    deps: {
      spawn: () => child,
      record: recorded,
      unrecord,
      kill,
      readProcessIdentity: async (pid: number) => live.get(pid) ?? null,
      getProcessMembers: async () => [...live.values()],
      diagnostic: vi.fn(),
    },
  };
}

describe("shell session backend", () => {
  beforeEach(() => {
    vi.stubEnv("TMUX", "/ambient/unrelated,123,0");
    vi.spyOn(tmuxModule, "tmuxFor").mockImplementation(() => {
      throw new Error("tmux forbidden");
    });
    vi.spyOn(TmuxSessionBackend, "create").mockRejectedValue(new Error("tmux forbidden"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("has no terminal, exact presentation and idle health without tmux", async () => {
    const backend: SessionBackend = await createSessionBackend({
      backend: "shell",
      options: { services: {} },
    });
    const presentation = vi.fn();
    const unsubscribe = backend.subscribePresentation(presentation);
    expect(Object.keys(backendFactories)).toEqual(["tmux", "shell"]);
    expect(backend.id).toBe("shell");
    expect(Object.values(backend.capabilities)).toEqual(Array.from({ length: 6 }, () => false));
    expect(backend.terminal).toBeUndefined();
    expect(backend.getPresentation()).toEqual({ kind: "shell" });
    expect(await backend.health()).toBe("alive");
    unsubscribe();
    expect(await backend.health()).toBe("alive");
    await backend.dispose();
    expect(await backend.health()).toBe("lost");
    expect(presentation).not.toHaveBeenCalled();
    expect(tmuxModule.tmuxFor).not.toHaveBeenCalled();
    expect(TmuxSessionBackend.create).not.toHaveBeenCalled();
  });

  it.each(["direct", "factory"])(
    "%s preflight rejects every raw candidate before allocation",
    async (entry) => {
      const spawnProcess = vi.fn(spawn);
      const services = Object.freeze({
        normal: Object.freeze({ start: "true" }),
        lazy: Object.freeze({ start: "true", raw: true, lazyPane: true, flags: { start: false } }),
      });
      const allocation = vi.fn(() => ({ spawn: spawnProcess }));
      const options = {
        services,
        get processes() {
          return allocation();
        },
      };
      const creation =
        entry === "direct"
          ? ShellSessionBackend.create(options)
          : createSessionBackend({ backend: "shell", options });
      await expect(creation).rejects.toMatchObject({
        code: "unsupported_config",
        service: "lazy",
        message: expect.stringContaining("raw"),
      });
      expect(allocation).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(services.lazy.flags.start).toBe(false);
    },
  );

  it.each([false, true])(
    "executes detached=%s with captured env/cwd and correlated final output",
    async (detached) => {
      const cwd = await mkdtemp(path.join(process.cwd(), ".shell-session-"));
      const service: ServiceConfig = Object.freeze({
        start: String.raw`printf "%s\n" "$VALUE"; pwd`,
        detached,
        lazyPane: true,
        flags: { start: false },
      });
      const spawnProcess = vi.fn(spawn);
      const backend = await ShellSessionBackend.create({
        services: { worker: service },
        processes: { spawn: spawnProcess },
      });
      const events: ExecutionEvent[] = [];
      const unsubscribe = backend.runtime.subscribe((event) => {
        events.push(event);
      });
      try {
        const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", VALUE: "literal '$ bytes" };
        const handle = await backend.runtime.start({
          ...spec,
          cwd,
          env,
          command: String(service.start),
          placement: detached ? "background" : "default",
        });
        env.VALUE = "changed after capture";
        await vi.waitFor(() => expect(events.some((event) => event.kind === "exit")).toBe(true));
        expect(
          events.filter((event) => event.kind === "output").flatMap((event) => event.lines),
        ).toEqual(["literal '$ bytes", cwd]);
        expect(events.map((event) => event.kind).slice(-2)).toEqual(["leaderExit", "exit"]);
        expect(
          events.every(
            (event) => event.unitId === handle.unitId && event.generation === handle.generation,
          ),
        ).toBe(true);
        expect(await backend.runtime.getPid(handle)).toBeUndefined();
        expect(await backend.runtime.isRunning(handle)).toBe(false);
        expect(await backend.health()).toBe("alive");
        expect(service).toMatchObject({ detached, lazyPane: true, flags: { start: false } });
        expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
          "sh",
          expect.arrayContaining(["-c"]),
          expect.objectContaining({
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "pipe"],
          }),
        );
        expect(tmuxModule.tmuxFor).not.toHaveBeenCalled();
        expect(TmuxSessionBackend.create).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await backend.dispose();
        await rm(cwd, { recursive: true });
      }
    },
  );

  it.each(["default", "background"] satisfies ExecutionSpec["placement"][])(
    "retains partial readiness without subscribers for %s",
    async (placement) => {
      const backend = await ShellSessionBackend.create({ services: {} });
      try {
        const handle = await backend.runtime.start({
          ...spec,
          placement,
          command: `'${process.execPath}' -e 'process.stdout.write("ready");setInterval(()=>{},1000)'`,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        await vi.waitFor(async () =>
          expect(await backend.runtime.readOutput(handle, 10)).toEqual(["ready"]),
        );
        backend.runtime.closeAdmission();
        await expect(backend.runtime.start({ ...spec, unitId: "late" })).rejects.toThrow(
          "session_closing",
        );
        await backend.runtime.stop(handle);
        expect(await backend.runtime.isRunning(handle)).toBe(false);
        expect(await backend.health()).toBe("alive");
      } finally {
        await backend.dispose();
      }
    },
  );

  it("seals delayed registration synchronously while retaining owned stop and journal cleanup", async () => {
    const h = pendingProcess();
    const backend = await ShellSessionBackend.create({ services: {}, processes: h.deps });
    const handle = await backend.runtime.start(spec);
    await vi.waitFor(() => expect(h.recorded).toHaveBeenCalledOnce());
    backend.runtime.closeAdmission();
    await expect(backend.runtime.start({ ...spec, unitId: "late" })).rejects.toThrow(
      "session_closing",
    );
    h.record.resolve();
    await vi.waitFor(() => expect(h.gate.destroyed).toBe(true));
    expect(h.gate.readableLength).toBe(0);
    await backend.runtime.stop(handle);
    expect(h.kill).toHaveBeenCalled();
    expect(h.unrecord).toHaveBeenCalledExactlyOnceWith(4242);
    await backend.dispose();
  });

  it("disposal seals pending launches and cleans owned processes once", async () => {
    const h = pendingProcess();
    const backend = await ShellSessionBackend.create({ services: {}, processes: h.deps });
    await backend.runtime.start(spec);
    await vi.waitFor(() => expect(h.recorded).toHaveBeenCalledOnce());
    const first = backend.dispose();
    expect(backend.dispose()).toBe(first);
    await expect(backend.runtime.start({ ...spec, unitId: "late" })).rejects.toThrow(
      "session_closing",
    );
    h.record.resolve();
    await first;
    expect(h.gate.readableLength).toBe(0);
    expect(h.live.size).toBe(0);
    expect(h.unrecord).toHaveBeenCalledExactlyOnceWith(4242);
    expect(await backend.health()).toBe("lost");
  });

  it("shares disposal, marks health lost immediately and preserves cleanup failures", async () => {
    const backend = await ShellSessionBackend.create({ services: {} });
    const cleanup = deferred();
    const disposal = vi
      .spyOn(ProcessRunner.prototype, "dispose")
      .mockImplementation(async () => cleanup.promise);
    const first = backend.dispose();
    expect(backend.dispose()).toBe(first);
    expect(await backend.health()).toBe("lost");
    cleanup.reject(new Error("owned cleanup incomplete"));
    await expect(first).rejects.toThrow("owned cleanup incomplete");
    await expect(backend.dispose()).rejects.toThrow("owned cleanup incomplete");
    expect(disposal).toHaveBeenCalledOnce();
  });

  it("preflight respects mixed raw capability without rewriting presentation preferences", async () => {
    const services = Object.freeze({
      worker: Object.freeze({
        start: "true",
        lazyPane: true,
        detached: false,
        flags: { start: false },
      }),
    });
    const layout = Object.freeze({ pane: "worker", size: "50%" });
    const backend = await ShellSessionBackend.create({ services, layout });
    expect(backend.getPresentation()).toEqual({ kind: "shell" });
    expect(layout).toEqual({ pane: "worker", size: "50%" });
    await backend.dispose();
    preflightBackendCompatibility(services, shellCapabilities);
    preflightBackendCompatibility(
      { worker: { raw: true } },
      { ...shellCapabilities, rawInput: true },
    );
    expect(services.worker).toEqual({
      start: "true",
      lazyPane: true,
      detached: false,
      flags: { start: false },
    });
  });

  it("factory preserves tmux construction options and runtime cleanup", async () => {
    vi.restoreAllMocks();
    const disposeRuntime = vi.fn(async () => undefined);
    const runtime = await ShellSessionBackend.create({ services: {} });
    const tmux = {
      ...tmuxModule.tmuxFor(null),
      resyncPaneSizes: vi.fn(async () => undefined),
      selectPane: vi.fn(async () => undefined),
    };
    const backend = await backendFactories.tmux({
      host: {
        tmuxSession: "personal",
        tmuxWindow: "@1",
        originPane: "%1",
        tmuxSocket: null,
        managedTmux: false,
      },
      tmux,
      runtime: runtime.runtime,
      disposeRuntime,
      services: {},
      skip: new Set(),
      groups: new Map(),
    });
    expect(backend).toBeInstanceOf(TmuxSessionBackend);
    expect(backend.getPresentation()).toMatchObject({ kind: "tmux", paneMap: { "@tui": "%1" } });
    await backend.dispose();
    expect(disposeRuntime).toHaveBeenCalledOnce();
    await runtime.dispose();
  });
});
