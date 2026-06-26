import { describe, expect, it, vi } from "vitest";

import { createZapsLib } from "../../src/config/builder.js";
import { ConfigError } from "../../src/config/errors.js";

describe("createZapsLib", () => {
  it("define returns the parsed config (input fields preserved + ui defaults)", () => {
    const { lib } = createZapsLib();
    const cfg = {
      name: "test",
      services: {
        app: { start: "npm start" },
      },
    };

    expect(lib.define(cfg)).toEqual({
      ...cfg,
      // The schema resolves the optional `ui` block to its defaults.
      ui: {
        icons: "nerd",
        notifications: "osc9",
        failOutput: "overlay",
        task: { defaultMode: "background", popupPicker: false },
        wideThreshold: 100,
      },
    });
  });

  it("throws readable error for invalid config", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.define({
        name: "test",
        services: {
          app: { start: 42 },
        },
      } as never),
    ).toThrow();
  });

  it("throws ConfigError(validation) with the offending field path", () => {
    const { lib } = createZapsLib();
    let caught: unknown;
    try {
      lib.define({
        name: "test",
        services: {
          app: { start: 42 },
        },
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({ kind: "validation", field: "services.app.start" });
  });

  it("throws when service has no start/run/docker", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.define({
        name: "test",
        services: { api: {} },
      }),
    ).toThrow("Service 'api' must have 'start', 'run', or 'docker' config");
  });

  it("throws when services is empty", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.define({
        name: "test",
        services: {},
      }),
    ).toThrow("Project must have at least one service");
  });

  it("task.run throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.task.run("test")).rejects.toThrow(
      "task.run is not available outside of service hooks",
    );
  });

  it("task.run delegates to bound actions after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const runTask = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask,
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
    });

    await lib.task.run("my-task");

    expect(runTask).toHaveBeenCalledWith("my-task");
  });

  it("service.start throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.service.start("svc")).rejects.toThrow(
      "service.start is not available outside of service hooks",
    );
  });

  it("service.start delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const startService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService,
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
    });

    await lib.service.start("db");

    expect(startService).toHaveBeenCalledWith("db");
  });

  it("service.restart throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.service.restart("svc")).rejects.toThrow(
      "service.restart is not available outside of service hooks",
    );
  });

  it("service.restart delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const restartService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService,
      stopService: vi.fn(),
      isServiceRunning: vi.fn(),
    });

    await lib.service.restart("api");

    expect(restartService).toHaveBeenCalledWith("api");
  });

  it("service.stop throws before binding", async () => {
    const { lib } = createZapsLib();
    await expect(lib.service.stop("svc")).rejects.toThrow(
      "service.stop is not available outside of service hooks",
    );
  });

  it("service.stop delegates after binding", async () => {
    const { lib, bindActions } = createZapsLib();
    const stopService = vi.fn().mockResolvedValue(undefined);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService,
      isServiceRunning: vi.fn(),
    });

    await lib.service.stop("worker");

    expect(stopService).toHaveBeenCalledWith("worker");
  });

  it("service.isRunning throws before binding", () => {
    const { lib } = createZapsLib();
    expect(() => lib.service.isRunning("svc")).toThrow(
      "service.isRunning is not available outside of service hooks",
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

  it("service.isRunning delegates after binding", () => {
    const { lib, bindActions } = createZapsLib();
    const isServiceRunning = vi.fn().mockReturnValue(true);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning,
    });

    const result = lib.service.isRunning("db");

    expect(isServiceRunning).toHaveBeenCalledWith("db");
    expect(result).toBe(true);
  });

  it("exposes find and cli namespaces", () => {
    const { lib } = createZapsLib();
    expect(typeof lib.find.up).toBe("function");
    expect(typeof lib.cli.fatal).toBe("function");
    expect(typeof lib.cli.warn).toBe("function");
    expect(typeof lib.browser.open).toBe("function");
  });

  it("throws when task has both commands and run", () => {
    const { lib } = createZapsLib();
    expect(() =>
      lib.define({
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
      lib.define({
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
      lib.define({
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
