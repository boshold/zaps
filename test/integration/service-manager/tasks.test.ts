import { describe, expect, it } from "vitest";

import type { TaskConfig } from "#src/config/types.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { runTaskWithDeps } from "#src/lib/task/runner.js";

function makeStatuses(): Map<string, ServiceStatus> {
  return new Map();
}

describe("tasks integration", () => {
  it("task with commands runs shell command", async () => {
    const results = new Map<string, "success" | "error">();
    const visited = new Set<string>();
    const completed: string[] = [];

    const tasks: Record<string, TaskConfig> = {
      build: {
        name: "Build",
        commands: "echo build-done",
      },
    };

    const ok = await runTaskWithDeps(
      "build",
      {
        tasks,
        statuses: makeStatuses(),
        projectDir: "/tmp",
        onProgress: (key, result) => {
          completed.push(`${key}:${result}`);
        },
      },
      visited,
      results,
    );

    expect(ok).toBe(true);
    expect(completed).toContain("build:success");
  });

  it("task failure", async () => {
    const results = new Map<string, "success" | "error">();
    const visited = new Set<string>();
    const completed: string[] = [];

    const tasks: Record<string, TaskConfig> = {
      fail: {
        name: "Fail",
        commands: "exit 1",
      },
    };

    const ok = await runTaskWithDeps(
      "fail",
      {
        tasks,
        statuses: makeStatuses(),
        projectDir: "/tmp",
        onProgress: (key, result) => {
          completed.push(`${key}:${result}`);
        },
      },
      visited,
      results,
    );

    expect(ok).toBe(false);
    expect(completed).toContain("fail:error");
  });

  it("task with dependsOn runs dep first", async () => {
    const results = new Map<string, "success" | "error">();
    const visited = new Set<string>();
    const order: string[] = [];

    const tasks: Record<string, TaskConfig> = {
      migrate: {
        name: "Migrate",
        commands: "echo migrate-done",
      },
      seed: {
        name: "Seed",
        commands: "echo seed-done",
        dependsOn: ["migrate"],
      },
    };

    const ok = await runTaskWithDeps(
      "seed",
      {
        tasks,
        statuses: makeStatuses(),
        projectDir: "/tmp",
        onProgress: (key) => {
          order.push(key);
        },
      },
      visited,
      results,
    );

    expect(ok).toBe(true);
    expect(order).toEqual(["migrate", "seed"]);
  });

  it("task dep failure blocks main", async () => {
    const results = new Map<string, "success" | "error">();
    const visited = new Set<string>();
    const completed: string[] = [];

    const tasks: Record<string, TaskConfig> = {
      migrate: {
        name: "Migrate",
        commands: "exit 1",
      },
      seed: {
        name: "Seed",
        commands: "echo seed-done",
        dependsOn: ["migrate"],
      },
    };

    const ok = await runTaskWithDeps(
      "seed",
      {
        tasks,
        statuses: makeStatuses(),
        projectDir: "/tmp",
        onProgress: (key, result) => {
          completed.push(`${key}:${result}`);
        },
      },
      visited,
      results,
    );

    expect(ok).toBe(false);
    expect(completed).toContain("migrate:error");
    // Seed should never have run
    expect(completed.find((c) => c.startsWith("seed:"))).toBeUndefined();
  });
});
