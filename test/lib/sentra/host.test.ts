import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createSentra, memoryStorage } from "@bosdev/sentra-core";
import type { SentraOptions } from "@bosdev/sentra-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SentraHost } from "#src/lib/sentra/host.js";
import type { SentraHostDeps } from "#src/lib/sentra/host.js";
import { readPortState, writePortState } from "#src/lib/sentra/paths.js";

let dir = "";
let portStatePath = "";
const hosts: SentraHost[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-sentra-host-"));
  portStatePath = path.join(dir, "sentra.json");
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function memorySentra(options?: SentraOptions) {
  return createSentra({ ...options, storage: memoryStorage() });
}

function makeHost(deps: SentraHostDeps = {}): SentraHost {
  const host = new SentraHost({
    createSentra: memorySentra,
    dbPath: path.join(dir, "sentra.db"),
    portStatePath,
    ...deps,
  });
  hosts.push(host);
  return host;
}

function runningPort(host: SentraHost): number {
  const { port } = host.status();
  if (port === null) {
    throw new Error("host has no port");
  }
  return port;
}

async function occupyPort(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function boundPort(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return address.port;
}

describe("SentraHost", () => {
  it("shares one in-flight start between concurrent callers", async () => {
    const create = vi.fn(memorySentra);
    const lines: string[] = [];
    const host = makeHost({ createSentra: create, logger: (msg) => lines.push(msg) });

    const [a, b, c] = await Promise.all([
      host.ensureStarted(),
      host.ensureStarted(),
      host.ensureStarted(),
    ]);

    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(host.sentra).toBe(a);
    expect(await host.ensureStarted()).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
    const port = runningPort(host);
    expect(create.mock.calls[0]?.[0]?.publicUrl).toBe(`http://127.0.0.1:${port}`);
    expect(host.status()).toEqual({
      state: "running",
      port,
      dbPath: path.join(dir, "sentra.db"),
      reason: null,
    });
    expect(readPortState(portStatePath)).toBe(port);
    expect(lines).toContain(
      `sentra listening on 127.0.0.1:${port} (db ${path.join(dir, "sentra.db")})`,
    );
  });

  it("reuses the persisted port when it is free", async () => {
    const probe = await occupyPort();
    const port = boundPort(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    writePortState(port, portStatePath);

    const host = makeHost();
    await host.ensureStarted();

    expect(runningPort(host)).toBe(port);
  });

  it("falls back to a random port when the persisted one is busy", async () => {
    const busy = await occupyPort();
    try {
      writePortState(boundPort(busy), portStatePath);
      const host = makeHost();
      await host.ensureStarted();

      const port = runningPort(host);
      expect(port).not.toBe(boundPort(busy));
      expect(readPortState(portStatePath)).toBe(port);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  it("answers 503 while the instance is still opening", async () => {
    let release = () => {
      /* Empty */
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listening = () => {
      /* Empty */
    };
    const bound = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const host = makeHost({
      createSentra: async (options) => {
        listening();
        await gate;
        return memorySentra(options);
      },
    });

    const started = host.ensureStarted();
    await bound;
    const response = await fetch(`http://127.0.0.1:${runningPort(host)}/p/s/web/api/1/envelope/`, {
      method: "POST",
      body: "{}\n",
    });
    expect(response.status).toBe(503);

    release();
    expect(await started).not.toBeNull();
  });

  it("answers 404 for non-ingest paths", async () => {
    const host = makeHost();
    await host.ensureStarted();

    const response = await fetch(`http://127.0.0.1:${runningPort(host)}/health`);
    expect(response.status).toBe(404);
  });

  it("ingests a real envelope sent to the DSN", async () => {
    const host = makeHost();
    const sentra = await host.ensureStarted();
    if (!sentra) {
      throw new Error("not started");
    }
    const dsn = new URL(host.getDsn({ project: "proj", session: "abc123", service: "web" }));
    expect(dsn.host).toBe(`127.0.0.1:${runningPort(host)}`);

    const eventId = "0123456789abcdef0123456789abcdef";
    const projectPath = dsn.pathname.replace(/\/(?<id>\d+)$/, "/api/$<id>/envelope/");
    const body = [
      JSON.stringify({ event_id: eventId }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({ event_id: eventId, level: "error", message: "boom", platform: "node" }),
      "",
    ].join("\n");
    const response = await fetch(new URL(projectPath, dsn.origin), { method: "POST", body });
    expect(response.status).toBe(200);

    const page = await sentra.query.listItems({ session: "abc123" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.eventId).toBe(eventId);
    expect(page.items[0]?.scope).toEqual({ project: "proj", session: "abc123", service: "web" });
  });

  it("marks the host unavailable on failure and throttles retries for 30s", async () => {
    let now = 1000;
    const create = vi
      .fn<typeof createSentra>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(memorySentra);
    const lines: string[] = [];
    const host = makeHost({ createSentra: create, now: () => now, logger: (m) => lines.push(m) });

    expect(await host.ensureStarted()).toBeNull();
    expect(host.status()).toMatchObject({ state: "unavailable", port: null, reason: "disk full" });
    expect(lines).toContain("sentra unavailable: disk full");

    now += 29_999;
    expect(await host.ensureStarted()).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await host.ensureStarted()).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
    expect(host.status()).toMatchObject({ state: "running", reason: null });
  });

  it("closes the server after a failed start", async () => {
    let port = 0;
    const host = makeHost({
      createSentra: async (options) => {
        port = Number(new URL(options?.publicUrl ?? "").port);
        return Promise.reject(new Error("nope"));
      },
    });

    await host.ensureStarted();

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("fails when the preferred port cannot be bound for another reason", async () => {
    writePortState(1, portStatePath);
    const host = makeHost();

    // Port 1 is privileged: EACCES unless running as root.
    const sentra = await host.ensureStarted();
    if (process.getuid?.() === 0) {
      expect(sentra).not.toBeNull();
      return;
    }
    expect(sentra).toBeNull();
    expect(host.status().state).toBe("unavailable");
  });

  it("closes idempotently and stops serving", async () => {
    const host = makeHost();
    const sentra = await host.ensureStarted();
    if (!sentra) {
      throw new Error("not started");
    }
    const closeSpy = vi.spyOn(sentra, "close");
    const port = runningPort(host);
    const listener = vi.fn();
    host.subscribe({}, listener);

    await host.close();
    await host.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(host.sentra).toBeNull();
    expect(host.status()).toMatchObject({ state: "stopped", port: null, reason: null });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("waits for an in-flight start before closing", async () => {
    const host = makeHost();
    const started = host.ensureStarted();
    await host.close();

    expect(await started).not.toBeNull();
    expect(host.status().state).toBe("stopped");
  });

  it("throws from getDsn and subscribe when not running", () => {
    const host = makeHost();
    expect(() => host.getDsn({ project: "p", session: "s", service: "w" })).toThrow(
      "Sentra is not running",
    );
    expect(() =>
      host.subscribe({}, () => {
        /* Empty */
      }),
    ).toThrow("Sentra is not running");
  });

  it("applies source roots added before and after start", async () => {
    const host = makeHost();
    host.addSourceRoot("/early");
    const sentra = await host.ensureStarted();
    if (!sentra) {
      throw new Error("not started");
    }
    const spy = vi.spyOn(sentra, "addSourceRoot");
    host.addSourceRoot("/late");
    expect(spy).toHaveBeenCalledWith("/late");
  });

  it("unsubscribes a tracked listener once", async () => {
    const host = makeHost();
    const sentra = await host.ensureStarted();
    if (!sentra) {
      throw new Error("not started");
    }
    const inner = vi.fn();
    vi.spyOn(sentra, "subscribe").mockReturnValue(inner);
    const unsubscribe = host.subscribe({}, () => {
      /* Empty */
    });
    unsubscribe();
    await host.close();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("forwards sentra logs to the daemon logger", async () => {
    const lines: string[] = [];
    const host = makeHost({
      logger: (msg) => lines.push(msg),
      createSentra: async (options) => {
        options?.logger?.debug("hidden");
        options?.logger?.info("hello");
        options?.logger?.warn("careful", { a: 1 });
        options?.logger?.error("bad");
        return memorySentra(options);
      },
    });
    await host.ensureStarted();
    expect(lines).toEqual(
      expect.arrayContaining([
        "sentra info: hello",
        'sentra warn: careful {"a":1}',
        "sentra error: bad",
      ]),
    );
    expect(lines.some((line) => line.includes("hidden"))).toBe(false);
  });
});
