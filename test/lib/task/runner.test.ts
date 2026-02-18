import type { TaskConfig } from "../../../src/config/types.js";
import type { ServiceStatus } from "../../../src/lib/service/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execCommand
vi.mock("#src/lib/exec.js", () => ({
  execCommand: vi.fn(async (_cmd: string, opts: { onLine: (line: string) => void }) => {
    opts.onLine("output-line");
  }),
}));

vi.mock("#src/lib/tmux.js", () => ({
  displayPopup: vi.fn().mockResolvedValue(undefined),
}));

import type { TaskRunnerDeps } from "../../../src/lib/task/runner.js";

import { execCommand } from "../../../src/lib/exec.js";
import { runTaskWithDeps } from "../../../src/lib/task/runner.js";
import { displayPopup } from "../../../src/lib/tmux.js";

const mockExecCommand = vi.mocked(execCommand);
const mockDisplayPopup = vi.mocked(displayPopup);

function makeDeps(
  tasks: Record<string, TaskConfig>,
  overrides?: Partial<TaskRunnerDeps>,
): TaskRunnerDeps {
  return {
    tasks,
    statuses: new Map<string, ServiceStatus>(),
    projectDir: "/test",
    ...overrides,
  };
}

beforeEach(() => {
  mockExecCommand.mockClear();
  mockDisplayPopup.mockClear();
  mockExecCommand.mockImplementation(async (_cmd: string, opts) => {
    opts.onLine("output-line");
  });
});

describe("runTaskWithDeps", () => {
  it("runs a single task", async () => {
    const deps = makeDeps({ build: { name: "Build", commands: "npm run build" } });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    const ok = await runTaskWithDeps("build", deps, visited, results);

    expect(ok).toBe(true);
    expect(results.get("build")).toBe("success");
    expect(mockExecCommand).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ cwd: "/test" }),
    );
  });

  it("runs dependencies first", async () => {
    const order: string[] = [];
    mockExecCommand.mockImplementation(async (cmd: string, opts) => {
      order.push(cmd);
      opts.onLine("line");
    });

    const deps = makeDeps({
      migrate: { name: "Migrate", commands: "migrate", dependsOn: ["build"] },
      build: { name: "Build", commands: "build" },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("migrate", deps, visited, results);

    expect(order).toEqual(["build", "migrate"]);
  });

  it("stops on dependency failure", async () => {
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "build") {
        throw new Error("fail");
      }
    });

    const deps = makeDeps({
      migrate: { name: "Migrate", commands: "migrate", dependsOn: ["build"] },
      build: { name: "Build", commands: "build" },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    const ok = await runTaskWithDeps("migrate", deps, visited, results);

    expect(ok).toBe(false);
    expect(results.get("build")).toBe("error");
    expect(results.has("migrate")).toBe(false);
  });

  it("throws for unknown task", async () => {
    const deps = makeDeps({});
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await expect(runTaskWithDeps("nope", deps, visited, results)).rejects.toThrow(
      "Unknown task dependency: nope",
    );
  });

  it("calls onProgress callback", async () => {
    mockExecCommand.mockImplementation(async (_cmd, opts) => {
      opts.onLine("line");
    });

    const onProgress = vi.fn();
    const deps = makeDeps({ build: { name: "Build", commands: "npm run build" } }, { onProgress });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("build", deps, visited, results);

    expect(onProgress).toHaveBeenCalledWith("build", "success");
  });

  it("calls onLine callback", async () => {
    mockExecCommand.mockImplementation(async (_cmd, opts) => {
      opts.onLine("hello world");
    });

    const onLine = vi.fn();
    const deps = makeDeps({ build: { name: "Build", commands: "echo hello" } }, { onLine });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("build", deps, visited, results);

    expect(onLine).toHaveBeenCalledWith("build", "hello world");
  });

  it("runs multiple commands sequentially", async () => {
    const order: string[] = [];
    mockExecCommand.mockImplementation(async (cmd: string, opts) => {
      order.push(cmd);
      opts.onLine("line");
    });

    const deps = makeDeps({
      deploy: { name: "Deploy", commands: ["build", "push"] },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("deploy", deps, visited, results);

    expect(order).toEqual(["build", "push"]);
    expect(results.get("deploy")).toBe("success");
  });

  it("resolves function commands", async () => {
    mockExecCommand.mockImplementation(async (_cmd, opts) => {
      opts.onLine("line");
    });

    const deps = makeDeps({
      build: { name: "Build", commands: () => "dynamic-cmd" },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("build", deps, visited, results);

    expect(mockExecCommand).toHaveBeenCalledWith("dynamic-cmd", expect.anything());
  });

  it("skips already-succeeded tasks in visited set", async () => {
    mockExecCommand.mockImplementation(async (_cmd, opts) => {
      opts.onLine("line");
    });

    const deps = makeDeps({
      build: { name: "Build", commands: "build" },
    });
    const visited = new Set<string>(["build"]);
    const results = new Map<string, "success" | "error">([["build", "success"]]);

    const ok = await runTaskWithDeps("build", deps, visited, results);

    expect(ok).toBe(true);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it("uses task cwd when specified", async () => {
    mockExecCommand.mockImplementation(async (_cmd, opts) => {
      opts.onLine("line");
    });

    const deps = makeDeps({
      build: { name: "Build", commands: "build", cwd: "/custom" },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("build", deps, visited, results);

    expect(mockExecCommand).toHaveBeenCalledWith(
      "build",
      expect.objectContaining({ cwd: "/custom" }),
    );
  });

  it("runs popup task via displayPopup with defaults", async () => {
    const deps = makeDeps({
      test: { name: "Test", commands: "npm test", popup: true },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    const ok = await runTaskWithDeps("test", deps, visited, results);

    expect(ok).toBe(true);
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockDisplayPopup).toHaveBeenCalledWith({
      cwd: "/test",
      command: "npm test; echo; echo 'Press Enter to close...'; read",
      title: "Test",
      width: "80%",
      height: "80%",
    });
  });

  it("runs popup task with custom dimensions", async () => {
    const deps = makeDeps({
      test: { name: "Test", commands: "npm test", popup: { width: "50%", height: "60%" } },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("test", deps, visited, results);

    expect(mockDisplayPopup).toHaveBeenCalledWith(
      expect.objectContaining({ width: "50%", height: "60%" }),
    );
  });

  it("joins multiple commands with && for popup", async () => {
    const deps = makeDeps({
      deploy: { name: "Deploy", commands: ["build", "push"], popup: true },
    });
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    await runTaskWithDeps("deploy", deps, visited, results);

    expect(mockDisplayPopup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "build && push; echo; echo 'Press Enter to close...'; read",
      }),
    );
  });

  it("reports error when popup task fails", async () => {
    mockDisplayPopup.mockRejectedValueOnce(new Error("Popup command failed with code 1"));
    const onProgress = vi.fn();
    const deps = makeDeps(
      { test: { name: "Test", commands: "fail", popup: true } },
      { onProgress },
    );
    const visited = new Set<string>();
    const results = new Map<string, "success" | "error">();

    const ok = await runTaskWithDeps("test", deps, visited, results);

    expect(ok).toBe(false);
    expect(results.get("test")).toBe("error");
    expect(onProgress).toHaveBeenCalledWith("test", "error");
  });
});
