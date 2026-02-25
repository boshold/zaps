import { describe, expect, it, vi } from "vitest";

import { createZapsLib } from "../../src/config/builder.js";

describe("createZapsLib", () => {
  it("defineProject returns equivalent config", () => {
    const { lib } = createZapsLib();
    const cfg = {
      name: "test",
      services: {
        app: { start: "npm start" },
      },
    };

    expect(lib.defineProject(cfg)).toEqual(cfg);
  });

  it("throws readable error for invalid config", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: {
          app: { start: 42 },
        },
      } as never),
    ).toThrow();
  });

  it("throws when service has no start/run/docker", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: { api: {} },
      }),
    ).toThrow("Service 'api' must have 'start', 'run', or 'docker' config");
  });

  it("throws when services is empty", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: {},
      }),
    ).toThrow("Project must have at least one service");
  });

  it("runTask throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.runTask("test")).rejects.toThrow(
      "runTask is not available outside of service hooks",
    );
  });

  it("runTask delegates to bound actions after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const runTask = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask,
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
      openInBrowser: vi.fn(),
    });

    await lib.runTask("my-task");

    expect(runTask).toHaveBeenCalledWith("my-task");
  });

  it("startService throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.startService("svc")).rejects.toThrow(
      "startService is not available outside of service hooks",
    );
  });

  it("startService delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const startService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService,
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
      openInBrowser: vi.fn(),
    });

    await lib.startService("db");

    expect(startService).toHaveBeenCalledWith("db");
  });

  it("restartService throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.restartService("svc")).rejects.toThrow(
      "restartService is not available outside of service hooks",
    );
  });

  it("restartService delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const restartService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService,
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
      openInBrowser: vi.fn(),
    });

    await lib.restartService("api");

    expect(restartService).toHaveBeenCalledWith("api");
  });

  it("stopService throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.stopService("svc")).rejects.toThrow(
      "stopService is not available outside of service hooks",
    );
  });

  it("stopService delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const stopService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService,
      isServiceRunning: vi.fn(),
      openInBrowser: vi.fn(),
    });

    await lib.stopService("worker");

    expect(stopService).toHaveBeenCalledWith("worker");
  });

  it("isServiceRunning throws before binding", () => {
    const { lib } = createZapsLib();
    expect(() => lib.isServiceRunning("svc")).toThrow(
      "isServiceRunning is not available outside of service hooks",
    );
  });

  it("exposes node built-in modules", () => {
    const { lib } = createZapsLib();
    expect(typeof lib.node.path.join).toBe("function");
    expect(typeof lib.node.fs.readFileSync).toBe("function");
    expect(typeof lib.node.process.cwd).toBe("function");
    expect(typeof lib.node.url.pathToFileURL).toBe("function");
    expect(typeof lib.node.os.homedir).toBe("function");
    expect(typeof lib.node.child_process.exec).toBe("function");
  });

  it("isServiceRunning delegates after binding", () => {
    const { lib, bindActions } = createZapsLib();
    const isServiceRunning = vi.fn().mockReturnValue(true);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning,
      openInBrowser: vi.fn(),
    });

    const result = lib.isServiceRunning("db");

    expect(isServiceRunning).toHaveBeenCalledWith("db");
    expect(result).toBe(true);
  });

  it("openInBrowser works without binding (calls lib/open directly)", async () => {
    const { lib } = createZapsLib();
    // OpenInBrowser should not throw even without bindActions
    // It calls the lib/open module directly, not through actions
    await expect(lib.openInBrowser("http://localhost:3000")).resolves.toBeUndefined();
  });

  it("throws when task has both commands and run", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: { app: { start: "npm start" } },
        tasks: {
          build: {
            name: "Build",
            commands: "npm build",
            run: async () => {
              /* Stub */
            },
          },
        },
      }),
    ).toThrow("Task must have either 'commands' or 'run', not both");
  });

  it("throws when task has neither commands nor run", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: { app: { start: "npm start" } },
        tasks: {
          build: {
            name: "Build",
          },
        },
      }),
    ).toThrow("Task must have either 'commands' or 'run'");
  });

  it("throws when task has popup with run", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: { app: { start: "npm start" } },
        tasks: {
          build: {
            name: "Build",
            run: async () => {
              /* Stub */
            },
            popup: true,
          },
        },
      }),
    ).toThrow("Task 'popup' can only be used with 'commands', not 'run'");
  });
});
