import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig } from "#src/config/types.js";
import { sessionHandlers } from "#src/daemon/handlers/session.js";
import { createShutdownAll } from "#src/daemon/index.js";
import { DaemonServer } from "#src/daemon/server.js";
import { TaskExecutionService } from "#src/daemon/task-execution.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { ShellRuntime } from "#src/lib/backend/shell/runtime.js";
import { ShellSessionBackend } from "#src/lib/backend/shell/session.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
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

  it("blocks established-socket allocation paths while preserving cleanup and daemon queries", async () => {
    const socket = path.join(root, "closing.sock");
    await server.start(socket);
    const sentra = vi.spyOn(server.sentra, "ensureStarted");
    server.closeAdmission();
    for (const method of [
      "session.create",
      "services.start",
      "tasks.run",
      "terminal.action",
      "exec-service.resolve",
      "sentra.status",
    ]) {
      const response = await ipcRequest(socket, method);
      expect(response.error).toBe("session_closing");
    }
    expect(sentra).not.toHaveBeenCalled();
    const ping = await ipcRequest(socket, "daemon.ping");
    const stop = await ipcRequest(socket, "services.stop");
    expect(ping.result).toBe("pong");
    expect(stop.error).toContain("Session required");
  });

  it("cancels config waiting without late backend allocation or registration", async () => {
    const loaded = deferred<Awaited<ReturnType<typeof loadProjectContext>>>();
    vi.mocked(loadProjectContext).mockReturnValueOnce(loaded.promise);
    const backend = vi.spyOn(ShellSessionBackend, "create");
    const pending = server.create(request());
    const rejected = expect(pending).rejects.toThrow("session_closing");
    expect(server.hasOwnedWork).toBe(true);
    server.closeAdmission();
    await server.settleCreates();
    await rejected;
    expect(server.hasOwnedWork).toBe(false);
    loaded.resolve({ config, env: captureEnvironment() });
    await Promise.resolve();
    expect(backend).not.toHaveBeenCalled();
    expect(server.ownedSessionIds()).toEqual([]);
    await expect(server.create(request())).rejects.toThrow("session_closing");
  });

  it("awaits an acquired backend before sweeping owners and never registers it after closure", async () => {
    const acquired = deferred<void>();
    const release = deferred<void>();
    const { create } = ShellSessionBackend;
    const dispose = vi.spyOn(ShellSessionBackend.prototype, "dispose");
    vi.spyOn(ShellSessionBackend, "create").mockImplementationOnce(async (options) => {
      const backend = await create(options);
      acquired.resolve();
      await release.promise;
      return backend;
    });
    const pending = server.create(request());
    const rejected = expect(pending).rejects.toThrow("session_closing");
    await acquired.promise;
    server.closeAdmission();
    let settled = false;
    const settling = (async () => {
      await server.settleCreates();
      settled = true;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(server.hasOwnedWork).toBe(true);
    release.resolve();
    await settling;
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(server.list()).toEqual([]);
    expect(server.hasOwnedWork).toBe(false);
  });

  it("attempts live Sessions after retained preparation cleanup fails during shutdown", async () => {
    config.bindActions = () => {
      throw new Error("construction failed");
    };
    vi.spyOn(ShellSessionBackend.prototype, "dispose").mockRejectedValueOnce(
      new Error("rollback failed"),
    );
    await expect(server.create(request())).rejects.toThrow("Session construction cleanup failed");
    const [retained] = server.ownedSessionIds();
    config.bindActions = undefined;
    const live = await server.create({ ...request(), configPath: path.join(root, "live.mts") });
    const retry = vi
      .spyOn(ShellSessionBackend.prototype, "retryCleanup")
      .mockRejectedValueOnce(new Error("retry failed"));
    await expect(createShutdownAll(server, vi.fn(), vi.fn())()).rejects.toThrow(
      "Daemon cleanup incomplete",
    );
    expect(live.destroyed).toBe(true);
    expect(server.list()).toEqual([]);
    expect(server.ownedSessionIds()).toEqual([retained]);
    expect(server.hasOwnedWork).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    await server.destroy(retained);
    expect(server.hasOwnedWork).toBe(false);
  });

  it("seals every live owner before awaiting any cleanup", async () => {
    const first = await server.create(request());
    const otherPath = path.join(root, "other.mts");
    const second = await server.create({ ...request(), configPath: otherPath });
    const held = deferred<void>();
    vi.spyOn(first.manager, "stopAll").mockReturnValueOnce(held.promise);
    server.closeAdmission();
    expect(first.taskExecution.accepting).toBe(false);
    expect(second.taskExecution.accepting).toBe(false);
    const cleanup = server.destroy(first.id);
    await expect(second.startAll()).rejects.toThrow("session_closing");
    held.resolve();
    await cleanup;
    await server.destroy(second.id);
  });

  it("cancels queued reload config waiting before destroy without interrupting JavaScript", async () => {
    const session = await server.create(request());
    await session.startPromise;
    const loaded = deferred<Awaited<ReturnType<typeof loadProjectContext>>>();
    vi.mocked(loadProjectContext).mockReturnValueOnce(loaded.promise);
    const reload = session.reload();
    const rejected = expect(reload).rejects.toThrow("session_closing");
    await vi.waitFor(() => expect(loadProjectContext).toHaveBeenCalledTimes(2));
    await server.destroy(session.id);
    await rejected;
    loaded.resolve({ config, env: captureEnvironment() });
    await Promise.resolve();
    expect(server.sessionCount).toBe(0);
  });

  it("sweeps retained preparation owners without fabricating session rows", async () => {
    config.bindActions = () => {
      throw new Error("construction failed");
    };
    vi.spyOn(ShellSessionBackend.prototype, "dispose").mockRejectedValueOnce(
      new Error("cleanup failed"),
    );
    const changed = vi.fn();
    server.onOwnershipChange = changed;
    await expect(server.create(request())).rejects.toThrow("Session construction cleanup failed");
    expect(server.list()).toEqual([]);
    expect(server.sessionCount).toBe(0);
    expect(server.hasOwnedWork).toBe(true);
    expect(server.ownedSessionIds()).toHaveLength(1);
    server.closeAdmission();
    await server.settleCreates();
    const [id] = server.ownedSessionIds();
    await server.destroy(id);
    expect(server.hasOwnedWork).toBe(false);
    expect(server.ownedSessionIds()).toEqual([]);
    expect(changed).toHaveBeenCalled();
    await server.destroy(id);
  });

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

  it.each(["manager", "Session"])(
    "retains %s construction cleanup ownership until retry succeeds",
    async (stage) => {
      const preparation = new Error(`${stage} construction failed`);
      const cleanup = new Error("backend cleanup failed");
      const create = vi.spyOn(ShellSessionBackend, "create");
      const backendDispose = vi
        .spyOn(ShellSessionBackend.prototype, "dispose")
        .mockRejectedValueOnce(cleanup);
      const observers = vi.spyOn(ServiceManager.prototype, "disposeObservers");
      if (stage === "manager") {
        config.bindActions = () => {
          throw preparation;
        };
      } else {
        vi.spyOn(ShellSessionBackend.prototype, "subscribePresentation").mockImplementationOnce(
          () => {
            throw preparation;
          },
        );
      }
      await expect(server.create(request())).rejects.toMatchObject({
        cause: preparation,
        errors: [preparation, cleanup],
      });
      expect(backendDispose).toHaveBeenCalledTimes(1);
      expect(server.sessionCount).toBe(0);
      if (stage === "Session") {
        expect(observers).toHaveBeenCalledTimes(1);
      }
      config.bindActions = undefined;
      const retry = vi
        .spyOn(ShellSessionBackend.prototype, "retryCleanup")
        .mockRejectedValueOnce(cleanup);
      await expect(server.create(request())).rejects.toThrow("Session construction cleanup failed");
      expect(create).toHaveBeenCalledTimes(1);
      expect(await server.create(request())).toBeDefined();
      expect(retry).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(2);
    },
  );

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
