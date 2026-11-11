import { describe, expect, it } from "vitest";

import type { TaskConfig } from "../../../src/config/types.js";
import { resolveTaskServiceRequirements } from "../../../src/lib/task/service-requirements.js";

function task(extra: Partial<TaskConfig> = {}): TaskConfig {
  return { name: "t", commands: "x", ...extra };
}

describe("resolveTaskServiceRequirements", () => {
  it("returns empty lists for a task without services", () => {
    expect(resolveTaskServiceRequirements({ lint: task() }, "lint")).toEqual({
      services: [],
      autoStartServices: [],
    });
  });

  it("returns own services; autoStart only when set", () => {
    const tasks = {
      seed: task({ services: ["db", "api"] }),
      mail: task({ services: ["mailhog"], autoStart: true }),
    };
    expect(resolveTaskServiceRequirements(tasks, "seed")).toEqual({
      services: ["db", "api"],
      autoStartServices: [],
    });
    expect(resolveTaskServiceRequirements(tasks, "mail")).toEqual({
      services: ["mailhog"],
      autoStartServices: ["mailhog"],
    });
  });

  it("unions the chain in execution order (dependencies first)", () => {
    const tasks = {
      deploy: task({ services: ["api"], dependsOn: ["migrate"] }),
      migrate: task({ services: ["db"], dependsOn: ["build"] }),
      build: task({ services: ["cache"] }),
    };
    expect(resolveTaskServiceRequirements(tasks, "deploy").services).toEqual([
      "cache",
      "db",
      "api",
    ]);
  });

  it("makes a shared service startable when any listing chain task has autoStart", () => {
    const tasks = {
      deploy: task({ services: ["db", "api"], dependsOn: ["migrate"] }),
      migrate: task({ services: ["db"], autoStart: true }),
    };
    expect(resolveTaskServiceRequirements(tasks, "deploy")).toEqual({
      services: ["db", "api"],
      autoStartServices: ["db"],
    });
  });

  it("does not inherit autoStart from tasks that do not list the service", () => {
    const tasks = {
      root: task({ services: ["api"], dependsOn: ["dep"] }),
      dep: task({ services: ["db"], autoStart: true }),
    };
    expect(resolveTaskServiceRequirements(tasks, "root").autoStartServices).toEqual(["db"]);
  });

  it("dedupes a diamond dependency", () => {
    const tasks = {
      a: task({ services: ["x"], dependsOn: ["b", "c"] }),
      b: task({ services: ["y"], dependsOn: ["d"] }),
      c: task({ services: ["z", "y"], dependsOn: ["d"] }),
      d: task({ services: ["w"] }),
    };
    expect(resolveTaskServiceRequirements(tasks, "a").services).toEqual(["w", "y", "z", "x"]);
  });

  it("keeps names that are not known services", () => {
    const tasks = { seed: task({ services: ["stripped-child"] }) };
    expect(resolveTaskServiceRequirements(tasks, "seed").services).toEqual(["stripped-child"]);
  });

  it("terminates on cycles", () => {
    const tasks = {
      a: task({ services: ["x"], dependsOn: ["b"] }),
      b: task({ services: ["y"], dependsOn: ["a"] }),
    };
    expect(resolveTaskServiceRequirements(tasks, "a").services).toEqual(["y", "x"]);
  });

  it("throws on unknown task key", () => {
    expect(() => resolveTaskServiceRequirements({}, "nope")).toThrow("Unknown task: nope");
  });

  it("throws on unknown dependency", () => {
    expect(() =>
      resolveTaskServiceRequirements({ a: task({ dependsOn: ["ghost"] }) }, "a"),
    ).toThrow("Unknown task: ghost");
  });
});
