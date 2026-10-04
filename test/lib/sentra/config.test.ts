import { describe, expect, it, vi } from "vitest";

import type { SentraConfig } from "#src/config/types.js";
import {
  buildSentraEnv,
  resolveSentraEnv,
  sanitizeSegment,
  sentraEnabledFor,
  sentraEnvFor,
  sentraLog,
  sentraTemplateFor,
} from "#src/lib/sentra/config.js";

import { fakeSentra, fakeSentraDsn } from "../../_helpers/fake-sentra.js";

const project: SentraConfig = {
  enabled: true,
  env: { SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" },
};
const own = { env: { DSN: "{dsn}" } };

describe("sentraEnabledFor", () => {
  const env = { SENTRY_DSN: "{dsn}" };

  it("is on with a project block unless enabled is false", () => {
    expect(sentraEnabledFor({ sentra: { env }, services: {} })).toBe(true);
    expect(
      sentraEnabledFor({ sentra: { enabled: false, env }, services: { a: { sentra: { env } } } }),
    ).toBe(false);
  });

  it("is on without a block when a service or task brings its own env", () => {
    expect(sentraEnabledFor({ services: { a: { sentra: { env } } } })).toBe(true);
    expect(sentraEnabledFor({ services: {}, tasks: { t: { sentra: { env } } } })).toBe(true);
  });

  it("is off without a block and without own-env targets", () => {
    expect(sentraEnabledFor({ services: { a: { sentra: true }, b: {} }, tasks: {} })).toBe(false);
    expect(sentraEnabledFor({ services: {} })).toBe(false);
  });
});

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

describe("buildSentraEnv", () => {
  it("starts the host, registers the source root and resolves the template", async () => {
    const deps = fakeSentra();
    expect(await buildSentraEnv(deps, { DSN: "{dsn}" }, "my web")).toEqual({
      DSN: fakeSentraDsn("my-web"),
    });
    expect(deps.host.addSourceRoot).toHaveBeenCalledWith("/test");
    expect(deps.host.getDsn).toHaveBeenCalledWith({
      project: "proj",
      session: "sess123",
      service: "my-web",
    });
  });

  it("reports a built env via onEnvBuilt only on success", async () => {
    const onEnvBuilt = vi.fn();
    await buildSentraEnv({ ...fakeSentra(false), onEnvBuilt }, { DSN: "{dsn}" }, "web");
    expect(onEnvBuilt).not.toHaveBeenCalled();
    await buildSentraEnv({ ...fakeSentra(), onEnvBuilt }, { DSN: "{dsn}" }, "web");
    expect(onEnvBuilt).toHaveBeenCalledOnce();
  });

  it("returns null and logs when the host is unavailable", async () => {
    const deps = fakeSentra(false);
    expect(await buildSentraEnv(deps, { DSN: "{dsn}" }, "web")).toBeNull();
    expect(deps.log).toHaveBeenCalledWith("sentra: web runs without Sentra env (port bind failed)");
    expect(deps.host.getDsn).not.toHaveBeenCalled();
  });

  it("returns null and logs when the DSN cannot be built", async () => {
    const onEnvBuilt = vi.fn();
    const deps = { ...fakeSentra(), onEnvBuilt };
    deps.host.getDsn.mockImplementation(() => {
      throw new Error("Sentra is not running");
    });
    expect(await buildSentraEnv(deps, { DSN: "{dsn}" }, "web")).toBeNull();
    expect(deps.log).toHaveBeenCalledWith(
      "sentra: web runs without Sentra env (Sentra is not running)",
    );
    expect(onEnvBuilt).not.toHaveBeenCalled();
  });

  it("falls back to a generic reason", async () => {
    const deps = fakeSentra(false);
    deps.host.status.mockReturnValue({ reason: null });
    await buildSentraEnv(deps, { DSN: "{dsn}" }, "web");
    expect(deps.log).toHaveBeenCalledWith("sentra: web runs without Sentra env (unavailable)");
  });
});

describe("sentraEnvFor", () => {
  it("returns {} without deps or template", async () => {
    expect(await sentraEnvFor(undefined, project, true, "web")).toEqual({});
    expect(await sentraEnvFor(fakeSentra(), undefined, true, "web")).toEqual({});
  });

  it("returns {} when the host is unavailable", async () => {
    expect(await sentraEnvFor(fakeSentra(false), project, true, "web")).toEqual({});
  });

  it("resolves the env for an opted-in target", async () => {
    expect(await sentraEnvFor(fakeSentra(), undefined, own, "web")).toEqual({
      DSN: fakeSentraDsn("web"),
    });
  });
});

describe("sentraLog", () => {
  it("falls back to stderr without a logger", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { log: _log, ...deps } = fakeSentra();
    sentraLog(deps, "hello");
    expect(write).toHaveBeenCalledWith("hello\n");
    write.mockRestore();
  });
});
