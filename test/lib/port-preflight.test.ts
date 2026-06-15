import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceConfig } from "../../src/config/types.js";
import {
  checkPortPreflight,
  deriveExpectedPorts,
  expandPortRange,
  isPortInUse,
  parseComposePorts,
  parseLsofOwner,
  parseSsOwner,
} from "../../src/lib/port-preflight.js";

describe("expandPortRange", () => {
  it("expands a single port", () => {
    expect(expandPortRange("8080")).toEqual([8080]);
  });

  it("expands a range", () => {
    expect(expandPortRange("8080-8082")).toEqual([8080, 8081, 8082]);
  });

  it("returns [] for empty string", () => {
    expect(expandPortRange("")).toEqual([]);
  });

  it("returns [] for non-numeric", () => {
    expect(expandPortRange("abc")).toEqual([]);
  });

  it("treats a descending/invalid range as the single start port", () => {
    expect(expandPortRange("9000-8000")).toEqual([9000]);
  });
});

describe("parseComposePorts", () => {
  function composeJson(ports: unknown): string {
    return JSON.stringify({ services: { db: { ports } } });
  }

  it("reads a plain published string", () => {
    expect(parseComposePorts(composeJson([{ target: 5432, published: "5432" }]), ["db"])).toEqual([
      5432,
    ]);
  });

  it("expands a published range", () => {
    expect(
      parseComposePorts(composeJson([{ target: 80, published: "8080-8081" }]), ["db"]),
    ).toEqual([8080, 8081]);
  });

  it("skips entries without a published field (unpublished port)", () => {
    expect(parseComposePorts(composeJson([{ target: 5432 }]), ["db"])).toEqual([]);
  });

  it("accepts a numeric published value defensively", () => {
    expect(parseComposePorts(composeJson([{ target: 5432, published: 5432 }]), ["db"])).toEqual([
      5432,
    ]);
  });

  it("returns null for non-JSON output (compose YAML regression)", () => {
    expect(parseComposePorts("services:\n  db:\n    image: postgres\n", ["db"])).toBeNull();
  });

  it("returns [] when the service has no ports", () => {
    expect(parseComposePorts(JSON.stringify({ services: { db: {} } }), ["db"])).toEqual([]);
  });

  it("aggregates ports across multiple service names", () => {
    const json = JSON.stringify({
      services: {
        a: { ports: [{ published: "1000" }] },
        b: { ports: [{ published: "2000" }] },
      },
    });
    expect((parseComposePorts(json, ["a", "b"]) ?? []).toSorted((x, y) => x - y)).toEqual([
      1000, 2000,
    ]);
  });
});

describe("deriveExpectedPorts", () => {
  it("returns the numeric ready.port", async () => {
    const svc: ServiceConfig = { start: "x", ready: { port: 3000 } };
    expect(await deriveExpectedPorts(svc, "/proj")).toEqual({ ports: [3000], skipped: false });
  });

  it("returns no ports for ready.port: true (auto-detect)", async () => {
    const svc: ServiceConfig = { start: "x", ready: { port: true } };
    expect(await deriveExpectedPorts(svc, "/proj")).toEqual({ ports: [], skipped: false });
  });

  it("returns no ports for a plain service with no ready.port", async () => {
    const svc: ServiceConfig = { start: "x" };
    expect(await deriveExpectedPorts(svc, "/proj")).toEqual({ ports: [], skipped: false });
  });

  it("derives docker ports from injected compose config", async () => {
    const svc: ServiceConfig = { docker: { service: "db" } };
    const result = await deriveExpectedPorts(svc, "/proj", {
      composeConfig: async () =>
        JSON.stringify({ services: { db: { ports: [{ published: "5432" }] } } }),
    });
    expect(result).toEqual({ ports: [5432], skipped: false });
  });

  it("skips pre-flight when compose output is not JSON", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const svc: ServiceConfig = { docker: { service: "db" } };
    const result = await deriveExpectedPorts(svc, "/proj", {
      composeConfig: async () => "not json",
    });
    expect(result).toEqual({ ports: [], skipped: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("parseSsOwner", () => {
  it("extracts pid and process name for the matching port", () => {
    const out = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      511    0.0.0.0:5432        0.0.0.0:*         users:(("postgres",pid=1234,fd=6))',
    ].join("\n");
    expect(parseSsOwner(out, 5432)).toBe("pid 1234 postgres");
  });

  it("returns undefined when no LISTEN row matches the port", () => {
    const out = 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("nginx",pid=9,fd=6))';
    expect(parseSsOwner(out, 5432)).toBeUndefined();
  });

  it("matches IPv6/wildcard local addresses by trailing port", () => {
    const out = 'LISTEN 0 4096 *:3000 *:* users:(("node",pid=42,fd=20))';
    expect(parseSsOwner(out, 3000)).toBe("pid 42 node");
  });
});

describe("parseLsofOwner", () => {
  it("extracts command and pid for the matching port", () => {
    const out = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "python3  4321 me      3u  IPv4  12345      0t0  TCP *:5432 (LISTEN)",
    ].join("\n");
    expect(parseLsofOwner(out, 5432)).toBe("pid 4321 python3");
  });
});

describe("isPortInUse", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("detects a port that is actively listening", async () => {
    const port = await new Promise<number>((resolve) => {
      server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    expect(await isPortInUse(port)).toBe(true);
  });

  it("reports a free port as not in use", async () => {
    // Bind then immediately close to obtain a very likely-free port number.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => resolve(p));
      });
    });
    expect(await isPortInUse(port)).toBe(false);
  });
});

describe("checkPortPreflight", () => {
  it("returns null when there are no expected ports", async () => {
    const svc: ServiceConfig = { start: "x" };
    expect(await checkPortPreflight(svc, "/proj")).toBeNull();
  });

  it("returns a conflict message for a port that is in use", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const svc: ServiceConfig = { start: "x", ready: { port } };
    const message = await checkPortPreflight(svc, "/proj");

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(message).toContain(`Port ${port} already in use`);
  });
});
