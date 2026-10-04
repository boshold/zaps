import { describe, expect, it } from "vitest";

import {
  expandOverrideSchema,
  projectConfigSchema,
  sentraEnvSchema,
  sentraProjectSchema,
  sentraTargetSchema,
} from "../../src/config/schema.js";

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((i) => i.message) ?? [];
}

describe("sentraEnvSchema", () => {
  it("accepts env with {dsn} in one value and literal others", () => {
    const env = { SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" };
    expect(sentraEnvSchema.parse(env)).toEqual(env);
  });

  it("accepts {dsn} embedded in a longer value", () => {
    expect(sentraEnvSchema.safeParse({ OPTS: "--dsn={dsn}" }).success).toBe(true);
  });

  it("rejects an empty record", () => {
    const result = sentraEnvSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("sentra.env must use {dsn} in at least one value");
  });

  it("rejects env without {dsn}", () => {
    const result = sentraEnvSchema.safeParse({ SENTRY_ENABLED: "true" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("sentra.env must use {dsn} in at least one value");
  });

  it.each(["1DSN", "SENTRY-DSN", "SENTRY DSN", ""])("rejects invalid key %j", (key) => {
    const result = sentraEnvSchema.safeParse({ [key]: "{dsn}", OK: "{dsn}" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      `sentra.env key '${key}' must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    );
    expect(result.error?.issues.find((issue) => issue.message.includes("key"))?.path).toEqual([
      key,
    ]);
  });

  it.each(["_DSN", "sentry_dsn", "A1"])("accepts key %j", (key) => {
    expect(sentraEnvSchema.safeParse({ [key]: "{dsn}" }).success).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(sentraEnvSchema.safeParse({ SENTRY_DSN: 1 }).success).toBe(false);
  });
});

describe("sentraProjectSchema", () => {
  it("defaults enabled to true", () => {
    expect(sentraProjectSchema.parse({ env: { SENTRY_DSN: "{dsn}" } })).toEqual({
      enabled: true,
      env: { SENTRY_DSN: "{dsn}" },
    });
  });

  it("keeps enabled: false", () => {
    expect(sentraProjectSchema.parse({ enabled: false, env: { D: "{dsn}" } }).enabled).toBe(false);
  });

  it("requires env", () => {
    expect(sentraProjectSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});

describe("sentraTargetSchema", () => {
  it.each([true, false, { env: { SENTRY_DSN: "{dsn}" } }])("accepts %j", (value) => {
    expect(sentraTargetSchema.safeParse(value).success).toBe(true);
  });

  it("rejects { env } without {dsn}", () => {
    const result = sentraTargetSchema.safeParse({ env: { SENTRY_ENABLED: "true" } });
    expect(result.success).toBe(false);
  });

  it.each(["yes", 1, {}])("rejects %j", (value) => {
    expect(sentraTargetSchema.safeParse(value).success).toBe(false);
  });
});

describe("projectConfigSchema sentra fields", () => {
  it("accepts project block and service/task targets", () => {
    const result = projectConfigSchema.parse({
      sentra: { env: { SENTRY_DSN: "{dsn}" } },
      services: {
        web: { start: "pnpm dev", sentra: true },
        api: { start: "pnpm api", sentra: { env: { DSN: "{dsn}" } } },
      },
      tasks: { e2e: { name: "E2E", commands: "pnpm e2e", sentra: true } },
    });
    expect(result.sentra).toEqual({ enabled: true, env: { SENTRY_DSN: "{dsn}" } });
    expect(result.services.web.sentra).toBe(true);
    expect(result.tasks?.e2e.sentra).toBe(true);
  });

  it("rejects an invalid project env", () => {
    const result = projectConfigSchema.safeParse({
      sentra: { env: { SENTRY_ENABLED: "true" } },
      services: { web: { start: "x" } },
    });
    expect(messages(result)).toContain("sentra.env must use {dsn} in at least one value");
  });

  it("rejects an invalid service target", () => {
    const result = projectConfigSchema.safeParse({
      services: { web: { start: "x", sentra: "on" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid task target", () => {
    const result = projectConfigSchema.safeParse({
      services: { web: { start: "x" } },
      tasks: { t: { name: "T", commands: "x", sentra: { env: {} } } },
    });
    expect(result.success).toBe(false);
  });
});

describe("expandOverrideSchema sentra", () => {
  it.each([true, false, { env: { SENTRY_DSN: "{dsn}" } }])("accepts sentra %j", (sentra) => {
    expect(expandOverrideSchema.safeParse({ sentra }).success).toBe(true);
  });

  it("rejects invalid sentra override", () => {
    expect(expandOverrideSchema.safeParse({ sentra: { env: { X: "y" } } }).success).toBe(false);
  });
});
