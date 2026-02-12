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

  it("isServiceRunning delegates after binding", () => {
    const { lib, bindActions } = createZapsLib();
    const isServiceRunning = vi.fn().mockReturnValue(true);
    bindActions({
      runTask: vi.fn(),
      startService: vi.fn(),
      restartService: vi.fn(),
      stopService: vi.fn(),
      isServiceRunning,
    });

    const result = lib.isServiceRunning("db");

    expect(isServiceRunning).toHaveBeenCalledWith("db");
    expect(result).toBe(true);
  });
});
