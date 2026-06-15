import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildServiceContext,
  formatEnvForShell,
  resolveEnv,
  setServiceEnv,
  shellEscape,
} from "../../../src/lib/service/env.js";
import type { EnvDeps, ServiceContext, ServiceStatus } from "../../../src/lib/service/types.js";

const mockSetEnv = vi.fn<EnvDeps["setEnv"]>();

function createDeps(): EnvDeps {
  return { setEnv: mockSetEnv };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildServiceContext", () => {
  it("builds context from multiple services with different ports", () => {
    const statuses = new Map<string, ServiceStatus>([
      [
        "db",
        {
          name: "db",
          state: "ready",
          ports: [5432],
          retryCount: 0,
        },
      ],
      [
        "api",
        {
          name: "api",
          state: "ready",
          ports: [3000, 3001],
          retryCount: 0,
        },
      ],
    ]);

    const ctx = buildServiceContext(statuses, "/home/user/project");

    expect(ctx.projectDir).toBe("/home/user/project");
    expect(ctx.services.db.port).toBe(5432);
    expect(ctx.services.db.ports).toEqual([5432]);
    expect(ctx.services.api.port).toBe(3000);
    expect(ctx.services.api.ports).toEqual([3000, 3001]);
  });

  it("handles service with no ports", () => {
    const statuses = new Map<string, ServiceStatus>([
      [
        "worker",
        {
          name: "worker",
          state: "ready",
          ports: [],
          retryCount: 0,
        },
      ],
    ]);

    const ctx = buildServiceContext(statuses, "/project");

    expect(ctx.services.worker.port).toBeUndefined();
    expect(ctx.services.worker.ports).toEqual([]);
  });

  it("falls back to projectDir when a service has no configured cwd", () => {
    const statuses = new Map<string, ServiceStatus>([
      [
        "svc",
        {
          name: "svc",
          state: "ready",
          ports: [8080],
          retryCount: 0,
        },
      ],
    ]);

    const ctx = buildServiceContext(statuses, "/dir");
    expect(ctx.services.svc.cwd).toBe("/dir");
  });

  it("uses the service's configured cwd when present", () => {
    const statuses = new Map<string, ServiceStatus>([
      [
        "svc",
        {
          name: "svc",
          state: "ready",
          ports: [8080],
          retryCount: 0,
        },
      ],
    ]);

    const ctx = buildServiceContext(statuses, "/dir", { svc: { cwd: "/dir/backend" } });
    expect(ctx.services.svc.cwd).toBe("/dir/backend");
  });
});

describe("resolveEnv", () => {
  it("returns static object as-is", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    const ctx: ServiceContext = { services: {}, projectDir: "/dir" };
    expect(resolveEnv(env, ctx)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("calls function with context and returns result", () => {
    const ctx: ServiceContext = {
      services: {
        db: { port: 5432, ports: [5432], cwd: undefined },
      },
      projectDir: "/dir",
    };
    const result = resolveEnv(
      (c: ServiceContext) => ({ DB_PORT: String(c.services.db?.port ?? "") }),
      ctx,
    );
    expect(result).toEqual({ DB_PORT: "5432" });
  });

  it("returns empty object when envConfig is undefined", () => {
    const ctx: ServiceContext = { services: {}, projectDir: "/dir" };
    expect(resolveEnv(undefined, ctx)).toEqual({});
  });
});

describe("shellEscape", () => {
  it("wraps normal string in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellEscape("don't")).toBe(String.raw`'don'\''t'`);
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles multiple single quotes", () => {
    expect(shellEscape("it's a 'test'")).toBe(String.raw`'it'\''s a '\''test'\'''`);
  });
});

describe("formatEnvForShell", () => {
  it("formats simple values", () => {
    expect(formatEnvForShell({ KEY: "value" })).toBe("KEY='value'");
  });

  it("formats values with spaces", () => {
    expect(formatEnvForShell({ MSG: "hello world" })).toBe("MSG='hello world'");
  });

  it("escapes values with single quotes", () => {
    expect(formatEnvForShell({ MSG: "don't" })).toBe(String.raw`MSG='don'\''t'`);
  });

  it("formats multiple vars space-separated", () => {
    const result = formatEnvForShell({ A: "1", B: "2" });
    expect(result).toBe("A='1' B='2'");
  });

  it("returns empty string for empty env", () => {
    expect(formatEnvForShell({})).toBe("");
  });
});

describe("setServiceEnv", () => {
  it("calls setEnv for each entry", async () => {
    mockSetEnv.mockResolvedValue();
    await setServiceEnv("my-session", { FOO: "bar", BAZ: "qux" }, createDeps());
    expect(mockSetEnv).toHaveBeenCalledTimes(2);
    expect(mockSetEnv).toHaveBeenCalledWith("my-session", "FOO", "bar");
    expect(mockSetEnv).toHaveBeenCalledWith("my-session", "BAZ", "qux");
  });

  it("does nothing for empty env", async () => {
    mockSetEnv.mockResolvedValue();
    await setServiceEnv("my-session", {}, createDeps());
    expect(mockSetEnv).not.toHaveBeenCalled();
  });
});
