import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../../../src/config/errors.js";
import {
  buildServiceContext,
  formatEnvForShell,
  resolveEnv,
  shellEscape,
} from "../../../src/lib/service/env.js";
import type { ServiceContext, ServiceStatus } from "../../../src/lib/service/types.js";

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

  it("exposes ctx.url() that builds a URL from the detected port", () => {
    const statuses = new Map<string, ServiceStatus>([
      ["api", { name: "api", state: "ready", ports: [3000], retryCount: 0 }],
      ["db", { name: "db", state: "ready", ports: [5432], retryCount: 0 }],
    ]);

    const ctx = buildServiceContext(statuses, "/dir");

    expect(typeof ctx.url).toBe("function");
    expect(ctx.url("api")).toBe("http://localhost:3000");
    expect(ctx.url("db", { protocol: "postgres", auth: "u:p", path: "/mydb" })).toBe(
      "postgres://u:p@localhost:5432/mydb",
    );
  });

  it("returns null from ctx.url() when no port is detected, dropping it from env", () => {
    const statuses = new Map<string, ServiceStatus>([
      ["worker", { name: "worker", state: "ready", ports: [], retryCount: 0 }],
    ]);

    const ctx = buildServiceContext(statuses, "/dir");
    expect(ctx.url("worker")).toBeNull();
    // A ctx.url() in an env callback → null is dropped (P01-T04 null-drop).
    expect(resolveEnv(() => ({ WORKER_URL: ctx.url("worker") }), ctx)).toEqual({});
  });

  it("throws ConfigError from ctx.url() for an unknown service", () => {
    const ctx = buildServiceContext(new Map(), "/dir");
    expect(() => ctx.url("ghost")).toThrow(ConfigError);
  });
});

describe("resolveEnv", () => {
  it("returns static object as-is", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    const ctx: ServiceContext = { services: {}, projectDir: "/dir", url: () => null };
    expect(resolveEnv(env, ctx)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("calls function with context and returns result", () => {
    const ctx: ServiceContext = {
      services: {
        db: { port: 5432, ports: [5432], cwd: undefined },
      },
      projectDir: "/dir",
      url: () => null,
    };
    const result = resolveEnv(
      (c: ServiceContext) => ({ DB_PORT: String(c.services.db?.port ?? "") }),
      ctx,
    );
    expect(result).toEqual({ DB_PORT: "5432" });
  });

  it("returns empty object when envConfig is undefined", () => {
    const ctx: ServiceContext = { services: {}, projectDir: "/dir", url: () => null };
    expect(resolveEnv(undefined, ctx)).toEqual({});
  });

  it("drops null/undefined values from a static object", () => {
    const ctx: ServiceContext = { services: {}, projectDir: "/dir", url: () => null };
    expect(resolveEnv({ A: "x", B: null, C: undefined }, ctx)).toEqual({ A: "x" });
  });

  it("drops null values returned by a function", () => {
    const ctx: ServiceContext = { services: {}, projectDir: "/dir", url: () => null };
    expect(resolveEnv(() => ({ A: "x", B: null }), ctx)).toEqual({ A: "x" });
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
