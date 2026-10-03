import { describe, expect, it } from "vitest";

import type { SentraConfig } from "#src/config/types.js";
import { resolveSentraEnv, sanitizeSegment, sentraTemplateFor } from "#src/lib/sentra/config.js";

const project: SentraConfig = {
  enabled: true,
  env: { SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" },
};
const own = { env: { DSN: "{dsn}" } };

describe("sentraTemplateFor", () => {
  it.each([undefined, false])("returns null for target %j", (target) => {
    expect(sentraTemplateFor(project, target)).toBeNull();
  });

  it("uses the project template for true", () => {
    expect(sentraTemplateFor(project, true)).toEqual(project.env);
  });

  it("treats a missing enabled flag as enabled", () => {
    expect(sentraTemplateFor({ env: project.env }, true)).toEqual(project.env);
  });

  it("returns null for true without a project block", () => {
    expect(sentraTemplateFor(undefined, true)).toBeNull();
  });

  it("uses the own template for { env }, replacing the project template", () => {
    expect(sentraTemplateFor(project, own)).toEqual(own.env);
  });

  it("allows { env } without a project block", () => {
    expect(sentraTemplateFor(undefined, own)).toEqual(own.env);
  });

  it.each([true, own])("returns null for %j when the project block is disabled", (target) => {
    expect(sentraTemplateFor({ ...project, enabled: false }, target)).toBeNull();
  });
});

describe("resolveSentraEnv", () => {
  it("replaces every {dsn} and keeps literal values", () => {
    expect(
      resolveSentraEnv(
        { A: "{dsn}", B: "x={dsn};y={dsn}", C: "true" },
        "http://sentra@h/p/s/svc/1",
      ),
    ).toEqual({
      A: "http://sentra@h/p/s/svc/1",
      B: "x=http://sentra@h/p/s/svc/1;y=http://sentra@h/p/s/svc/1",
      C: "true",
    });
  });
});

describe("sanitizeSegment", () => {
  it.each([
    ["web", "web"],
    ["my.app_v-2", "my.app_v-2"],
    ["my project/web", "my-project-web"],
    ["a  //  b", "a-b"],
    ["a--b", "a-b"],
    ["ünïcödé", "-n-c-d-"],
    ["", "default"],
    [".", "default"],
    ["..", "default"],
    ["...", "..."],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeSegment(input)).toBe(expected);
  });

  it("trims to 64 chars", () => {
    expect(sanitizeSegment("x".repeat(100))).toBe("x".repeat(64));
  });
});
