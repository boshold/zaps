import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig } from "#src/config/types.js";
import { sessionHandlers } from "#src/daemon/handlers/session.js";
import { DaemonServer } from "#src/daemon/server.js";
import { TaskExecutionService } from "#src/daemon/task-execution.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { ShellRuntime } from "#src/lib/backend/shell/runtime.js";
import { ShellSessionBackend } from "#src/lib/backend/shell/session.js";
import { captureEnvironment } from "#src/lib/request-context.js";
import { shellEscape } from "#src/lib/service/env.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import { tmuxFor } from "#src/lib/tmux.js";

vi.mock("#src/config/project-context.js", () => ({ loadProjectContext: vi.fn() }));
vi.mock("#src/lib/tmux.js", () => ({
  tmuxFor: vi.fn(() => {
    throw new Error("Shell must never construct tmux");
  }),
}));

function deferred<T>() {
  let accept: (value: T) => void = () => {
    throw new Error("Not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    accept = resolve;
  });
  return { promise, resolve: accept };
}

describe("session creation with real shell orchestration", () => {
  let root: string;
  let config: ResolvedConfig;
  let server: DaemonServer;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-create-"));
    vi.stubEnv("XDG_RUNTIME_DIR", root);
    config = {
      configPath: path.join(root, ".zaps.mts"),
      projectDir: root,
      project: { name: "creation", services: {} },
      groups: new Map(),
      unavailableServices: new Map(),
      lazyPaneByService: new Map(),
    };
    vi.mocked(loadProjectContext).mockImplementation(async () => ({
      config,
      env: captureEnvironment(),
    }));
    server = new DaemonServer();
  });

  afterEach(async () => {
    server.onSessionChange = undefined;
    try {
      for (const session of server.list()) {
        await server.destroy(session.id);
      }
    } finally {
      server.stop();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function request() {
    return {
      backend: "shell",
      configPath: config.configPath,
      projectDir: root,
    } satisfies Parameters<DaemonServer["create"]>[0];
  }

  it.each(["'./effective'", "({ configDir }) => configDir + '/effective'"])(
    "resolves no-hint cwd %s once per invocation and converges after project .env loading",
    async (cwd) => {
      const actual = await vi.importActual<typeof import("#src/config/project-context.js")>(
        "#src/config/project-context.js",
      );
      vi.mocked(loadProjectContext).mockImplementation(actual.loadProjectContext);
      const effective = path.join(root, "effective");
      const otherInvoke = path.join(root, "other");
      fs.mkdirSync(effective);
      fs.mkdirSync(otherInvoke);
      fs.writeFileSync(path.join(effective, ".env"), "PROJECT_NAME=effective\n");
      fs.writeFileSync(
        config.configPath,
        `export function config({ define }) {
        return define({ cwd: ${cwd}, name: process.env.PROJECT_NAME ?? 'probe', services: { idle: { start: 'true', flags: { start: false } } } });
      }`,
      );
      const params = { ...request(), shellEnv: {} };
      const [first, second] = await Promise.all([
        server.create(params),
        server.create({ ...params, projectDir: otherInvoke }),
      ]);
      expect(first).toBe(second);
      expect(first.projectDir).toBe(effective);
      expect(first.name).toBe("effective");
      expect(server.get(first.id)).toBe(first);
      expect(server.list()).toEqual([first]);
      await server.destroy(first.id);
      expect(server.get(first.id)).toBeUndefined();
    },
  );

  it("keeps actual function-cwd roots distinct under one config", async () => {
    const actual = await vi.importActual<typeof import("#src/config/project-context.js")>(
      "#src/config/project-context.js",
    );
    vi.mocked(loadProjectContext).mockImplementation(actual.loadProjectContext);
    fs.writeFileSync(
      config.configPath,
      `export function config({ define }) {
      return define({ cwd: ({ invokeDir }) => invokeDir, services: { idle: { start: 'true', flags: { start: false } } } });
    }`,
    );
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    const params = { ...request(), shellEnv: {} };
    const [first, second] = await Promise.all([
      server.create(params),
      server.create({ ...params, projectDir: other }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(server.get(first.id)).toBe(first);
    expect(server.get(second.id)).toBe(second);
  });

  it("returns prepared while startup is pending; reporting joins one dependency-ordered launch", async () => {
    const beforeStart = deferred<void>();
    const readiness = deferred<boolean>();
    const hook = vi.fn(async () => beforeStart.promise);
    const command = `exec ${shellEscape(process.execPath)} -e 'setInterval(() => {}, 1000)' ${shellEscape(root)}`;
    config.project = {
      name: "creation",
      hooks: { onBeforeStart: hook },
      services: {
        first: { start: command, ready: async () => readiness.promise, sentra: false },
        second: { start: command, dependsOn: ["first"], sentra: false },
        disabled: { start: command, flags: { start: false }, sentra: false },
      },
    };
    const start = vi.spyOn(ShellRuntime.prototype, "start");
    const session = await server.create(request());
    expect(session.startPromise).toBeInstanceOf(Promise);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    let startupSettled = false;
    void session.startPromise?.then(() => {
      startupSettled = true;
      return true;
    });
    const socket = new net.Socket();
    try {
      const reporting = sessionHandlers["services.startAll"](
        { id: "report", method: "services.startAll", session: session.id },
        server,
        socket,
      );
      expect(await server.create(request())).toBe(session);
      server.list();
      session.attachSnapshot();
      expect(startupSettled).toBe(false);
      expect(hook).toHaveBeenCalledTimes(1);
      beforeStart.resolve();
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(start.mock.calls[0][0].unitId).toBe("first");
      expect(session.manager.getStatus("first")?.state).toBe("starting");
      readiness.resolve(true);
      expect(await reporting).toMatchObject({ result: { started: "all" } });
      await session.startPromise;
      expect(start.mock.calls.map(([spec]) => spec.unitId)).toEqual(["first", "second"]);
      expect(session.manager.getStatus("first")?.state).toBe("ready");
      expect(session.manager.getStatus("second")?.state).toBe("ready");
      expect(session.manager.getStatus("disabled")?.state).toBe("stopped");
      await session.manager.stopAll();
      expect(fs.readFileSync(path.join(root, "zaps", "detached.json"), "utf8")).toBe("{}");
      expect(await server.create(request())).toBe(session);
      session.attachSnapshot();
      expect(start).toHaveBeenCalledTimes(2);
      expect(tmuxFor).not.toHaveBeenCalled();
    } finally {
      beforeStart.resolve();
      readiness.resolve(true);
      socket.destroy();
    }
  });

  it("disposes backend resources when manager construction throws", async () => {
    config.bindActions = () => {
      throw new Error("manager failed");
    };
    const backend = vi.spyOn(ShellSessionBackend.prototype, "dispose");
    const processes = vi.spyOn(ProcessRunner.prototype, "dispose");
    await expect(server.create(request())).rejects.toThrow("manager failed");
    expect(server.sessionCount).toBe(0);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(processes).toHaveBeenCalledTimes(1);
    config.bindActions = undefined;
    expect(await server.create(request())).toBeDefined();
  });

  it("removes manager observers if Session construction fails", async () => {
    const observer = vi.spyOn(ServiceManager.prototype, "disposeObservers");
    const presentation = vi
      .spyOn(ShellSessionBackend.prototype, "subscribePresentation")
      .mockImplementationOnce(() => {
        throw new Error("session failed");
      });
    const backend = vi.spyOn(ShellSessionBackend.prototype, "dispose");
    await expect(server.create(request())).rejects.toThrow("session failed");
    expect(observer).toHaveBeenCalledTimes(1);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(server.sessionCount).toBe(0);
    presentation.mockRestore();
  });

  it("preserves registration failure and cleanup diagnostics while disposing task ownership", async () => {
    const cause = new Error("count failed");
    const cleanup = new Error("observer cleanup failed");
    const sentraCleanup = new Error("sentra cleanup failed");
    vi.spyOn(server.sentraCounter, "detach").mockImplementationOnce(() => {
      throw sentraCleanup;
    });
    const { disposeObservers } = ServiceManager.prototype;
    vi.spyOn(ServiceManager.prototype, "disposeObservers").mockImplementationOnce(
      function disposeAndFail(this: ServiceManager) {
        disposeObservers.call(this);
        throw cleanup;
      },
    );
    const tasks = vi.spyOn(TaskExecutionService.prototype, "dispose");
    const backend = vi.spyOn(ShellSessionBackend.prototype, "dispose");
    server.onSessionChange = () => {
      throw cause;
    };
    await expect(server.create(request())).rejects.toMatchObject({
      cause,
      errors: [cause, sentraCleanup, expect.objectContaining({ errors: [cleanup] })],
    });
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(server.sessionCount).toBe(1);
    server.onSessionChange = undefined;
    await expect(server.create(request())).rejects.toThrow("Session cleanup incomplete");
    const [closing] = server.list();
    expect(closing.destroyed).toBe(true);
    // Every resource was actually disposed before these injected diagnostic failures.
    vi.spyOn(closing, "destroy").mockResolvedValueOnce(undefined);
    await server.destroy(closing.id);
    expect(server.sessionCount).toBe(0);
  });
});
