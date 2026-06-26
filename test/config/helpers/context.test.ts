import { describe, expect, it } from "vitest";

import { ConfigError } from "../../../src/config/errors.js";
import { buildUrl } from "../../../src/config/helpers/context.js";
import type { ServiceContext } from "../../../src/config/types.js";

type Services = ServiceContext["services"];

const services: Services = {
  api: { port: 3000, ports: [3000], cwd: undefined },
  db: { port: 5432, ports: [5432], cwd: undefined },
  noPort: { port: undefined, ports: [], cwd: undefined },
};

describe("buildUrl", () => {
  it("throws ConfigError(validation) for an unknown service", () => {
    let caught: unknown;
    try {
      buildUrl(services, "ghost");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({ kind: "validation", service: "ghost" });
  });

  it("returns null when the service has no detected port and no override", () => {
    expect(buildUrl(services, "noPort")).toBeNull();
  });

  it("builds a default http://localhost URL from the detected port", () => {
    expect(buildUrl(services, "api")).toBe("http://localhost:3000");
  });

  it("applies protocol, auth, and path overrides", () => {
    expect(
      buildUrl(services, "db", { protocol: "postgres", auth: "user:pass", path: "/mydb" }),
    ).toBe("postgres://user:pass@localhost:5432/mydb");
  });

  it("overrides the detected port", () => {
    expect(buildUrl(services, "api", { port: 8080 })).toBe("http://localhost:8080");
  });

  it("uses the port override when the service has no detected port", () => {
    expect(buildUrl(services, "noPort", { port: 3000 })).toBe("http://localhost:3000");
  });

  it("honors a host override", () => {
    expect(buildUrl(services, "api", { host: "example.com" })).toBe("http://example.com:3000");
  });

  it("prefixes a leading slash on a non-slash path", () => {
    expect(buildUrl(services, "db", { protocol: "postgres", path: "mydb" })).toBe(
      "postgres://localhost:5432/mydb",
    );
  });

  it("keeps an already-slashed path as-is", () => {
    expect(buildUrl(services, "api", { path: "/health" })).toBe("http://localhost:3000/health");
  });

  it("omits an empty path", () => {
    expect(buildUrl(services, "api", { path: "" })).toBe("http://localhost:3000");
  });

  it("omits empty auth", () => {
    expect(buildUrl(services, "api", { auth: "" })).toBe("http://localhost:3000");
  });

  it("brackets an IPv6 host", () => {
    expect(buildUrl(services, "api", { host: "::1" })).toBe("http://[::1]:3000");
  });

  it("brackets an IPv6 host with auth and path", () => {
    expect(buildUrl(services, "db", { host: "::1", auth: "u:p", path: "db" })).toBe(
      "http://u:p@[::1]:5432/db",
    );
  });
});
