import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSentra, memoryStorage } from "@boshold/sentra-core";
import type { Sentra } from "@boshold/sentra-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { daemonHandlers } from "#src/daemon/handlers/daemon.js";
import { sentraHandlers } from "#src/daemon/handlers/sentra.js";
import type { SessionStore } from "#src/daemon/server.js";
import type { IpcRequest, IpcResponse } from "#src/lib/ipc/protocol.js";
import { ErrorCounter } from "#src/lib/sentra/counter.js";
import { SentraHost } from "#src/lib/sentra/host.js";
import {
  errorsResultSchema,
  issuesResultSchema,
  showResultSchema,
  statusResultSchema,
} from "#src/lib/sentra/schemas.js";

import { createMockSession, createMockStore } from "../../_helpers/mock-session.js";
import type { MockSession } from "../../_helpers/mock-session.js";
import { SESSION_A, SESSION_B, ingestEvent } from "../../_helpers/sentra.js";

let dir = "";
let host: SentraHost;

function makeHost(create: () => Promise<Sentra>): SentraHost {
  return new SentraHost({
    createSentra: create,
    dbPath: path.join(dir, "sentra.db"),
    portStatePath: path.join(dir, "sentra.json"),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-sentra-handlers-"));
  host = makeHost(async () =>
    createSentra({ storage: memoryStorage(), sourceMaps: { enabled: false } }),
  );
});

afterEach(async () => {
  await host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeWith(sessions: MockSession[] = []): SessionStore {
  return { ...createMockStore(sessions), sentra: host, sentraCounter: new ErrorCounter(host) };
}

function runningSession(sentra?: { enabled?: boolean; env: Record<string, string> }): MockSession {
  const base = createMockSession({ id: SESSION_A });
  return createMockSession({
    id: SESSION_A,
    config: {
      ...base.config,
      project: {
        name: "proj",
        services: {
          web: { start: "pnpm dev", sentra: true },
          api: { start: "pnpm api", sentra: { env: { SENTRY_DSN: "{dsn}" } } },
          db: { start: "pg" },
        },
        sentra,
      },
    },
  });
}

function sessionWith(project: {
  services: Record<string, unknown>;
  tasks?: Record<string, unknown>;
}): MockSession {
  const base = createMockSession({ id: SESSION_A });
  return createMockSession({
    id: SESSION_A,
    config: { ...base.config, project: { name: "proj", ...project } },
  });
}

let nextId = 0;
async function call(
  store: SessionStore,
  method: string,
  params: Record<string, unknown>,
): Promise<IpcResponse> {
  const handler = sentraHandlers[method];
  if (!handler) {
    throw new Error(`no handler ${method}`);
  }
  const req: IpcRequest = { id: `r${(nextId += 1)}`, method, params };
  return handler(req, store);
}

async function seeded(): Promise<Sentra> {
  const sentra = await host.ensureStarted();
  if (!sentra) {
    throw new Error("sentra did not start");
  }
  await ingestEvent(sentra, { service: "web", error: { type: "TypeError", value: "boom" } });
  await ingestEvent(sentra, { session: SESSION_B, error: { type: "Error", value: "other" } });
  return sentra;
}

const ENABLED = { env: { SENTRY_DSN: "{dsn}" } };

describe("sentra handlers", () => {
  it("are registered as daemon handlers", () => {
    for (const method of Object.keys(sentraHandlers)) {
      expect(daemonHandlers[method]).toBe(sentraHandlers[method]);
    }
    expect(Object.keys(sentraHandlers).toSorted()).toEqual([
      "sentra.clear",
      "sentra.errors",
      "sentra.issues",
      "sentra.show",
      "sentra.status",
    ]);
  });

  describe("sentra.status", () => {
    it("reports running state and opted-in services for a running session", async () => {
      const res = await call(storeWith([runningSession(ENABLED)]), "sentra.status", {
        sessionId: SESSION_A,
      });
      const status = statusResultSchema.parse(res.result);
      expect(status).toMatchObject({
        enabled: true,
        state: "running",
        reason: null,
        dbPath: path.join(dir, "sentra.db"),
        services: ["web", "api"],
      });
      expect(status.port).toEqual(expect.any(Number));
    });

    it("reports disabled without starting Sentra", async () => {
      const res = await call(
        storeWith([runningSession({ ...ENABLED, enabled: false })]),
        "sentra.status",
        { sessionId: SESSION_A },
      );
      expect(statusResultSchema.parse(res.result)).toMatchObject({
        enabled: false,
        state: "disabled",
        port: null,
        services: [],
      });
      expect(host.status().state).toBe("stopped");
    });

    it("treats no block and no { env } targets as disabled", async () => {
      const session = sessionWith({
        services: { web: { start: "pnpm dev", sentra: true }, db: { start: "pg" } },
      });
      const res = await call(storeWith([session]), "sentra.status", { sessionId: SESSION_A });
      expect(res.result).toMatchObject({ enabled: false, state: "disabled" });
    });

    it("treats a service { env } target without a project block as enabled", async () => {
      await seeded();
      const session = sessionWith({
        services: { api: { start: "pnpm api", sentra: { env: { SENTRY_DSN: "{dsn}" } } } },
      });
      const store = storeWith([session]);

      const status = await call(store, "sentra.status", { sessionId: SESSION_A });
      const errors = await call(store, "sentra.errors", { sessionId: SESSION_A });

      expect(status.result).toMatchObject({ enabled: true, state: "running", services: ["api"] });
      expect(errorsResultSchema.parse(errors.result).errors).toHaveLength(1);
    });

    it("treats a task-only { env } target as enabled", async () => {
      const session = sessionWith({
        services: { db: { start: "pg" } },
        tasks: { e2e: { name: "E2E", commands: "pnpm e2e", sentra: { env: { DSN: "{dsn}" } } } },
      });

      const res = await call(storeWith([session]), "sentra.status", { sessionId: SESSION_A });

      expect(res.result).toMatchObject({ enabled: true, state: "running", services: [] });
    });

    it("skips the enabled check for a stopped session", async () => {
      const res = await call(storeWith(), "sentra.status", { sessionId: SESSION_A });
      expect(statusResultSchema.parse(res.result)).toMatchObject({
        enabled: null,
        state: "running",
        services: [],
      });
    });

    it("reports unavailable with reason", async () => {
      await host.close();
      host = makeHost(async () => Promise.reject(new Error("db locked")));
      const res = await call(storeWith(), "sentra.status", { sessionId: SESSION_A });
      expect(res.result).toMatchObject({ state: "unavailable", reason: "db locked" });
    });

    it("rejects invalid params", async () => {
      const res = await call(storeWith(), "sentra.status", { sessionId: "nope" });
      expect(res.error).toMatch(/^invalid_filter: /);
    });
  });

  describe("sentra.errors", () => {
    it("lists errors of the session (stopped-session path)", async () => {
      await seeded();
      const res = await call(storeWith(), "sentra.errors", { sessionId: SESSION_A });
      const result = errorsResultSchema.parse(res.result);
      expect(result.errors.map((row) => row.title)).toEqual(["TypeError: boom"]);
      expect(result.hasMore).toBe(false);
    });

    it("works for a running enabled session", async () => {
      await seeded();
      const res = await call(storeWith([runningSession(ENABLED)]), "sentra.errors", {
        sessionId: SESSION_A,
        service: ["web"],
      });
      expect(errorsResultSchema.parse(res.result).errors).toHaveLength(1);
    });

    it("returns sentra_disabled for a running disabled session", async () => {
      const res = await call(
        storeWith([runningSession({ ...ENABLED, enabled: false })]),
        "sentra.errors",
        { sessionId: SESSION_A },
      );
      expect(res.error).toBe(
        'sentra_disabled: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.',
      );
    });

    it("returns sentra_unavailable when the host cannot start", async () => {
      await host.close();
      host = makeHost(async () => Promise.reject(new Error("db locked")));
      const res = await call(storeWith(), "sentra.errors", { sessionId: SESSION_A });
      expect(res.error).toBe("sentra_unavailable: db locked");
    });

    it("returns invalid_filter for bad params", async () => {
      const bad = await call(storeWith(), "sentra.errors", {
        sessionId: SESSION_A,
        level: ["loud"],
      });
      const missing = await call(storeWith(), "sentra.errors", {});
      expect(bad.error).toMatch(/^invalid_filter: .*level/s);
      expect(missing.error).toMatch(/^invalid_filter: .*sessionId/s);
    });

    it("maps query errors 1:1", async () => {
      const res = await call(storeWith(), "sentra.errors", {
        sessionId: SESSION_A,
        since: "1m",
        from: "1m",
      });
      expect(res.error).toBe("invalid_filter: --since and --from cannot be combined.");
    });
  });

  describe("sentra.issues", () => {
    it("lists issues of the session", async () => {
      await seeded();
      const res = await call(storeWith(), "sentra.issues", { sessionId: SESSION_A });
      const result = issuesResultSchema.parse(res.result);
      expect(result.issues.map((row) => row.title)).toEqual(["TypeError: boom"]);
    });
  });

  describe("sentra.show", () => {
    it("shows a record and maps not_found", async () => {
      await seeded();
      const listed = await call(storeWith(), "sentra.errors", { sessionId: SESSION_A });
      const list = errorsResultSchema.parse(listed.result);
      const [row] = list.errors;
      if (!row) {
        throw new Error("expected a row");
      }

      const shown = await call(storeWith(), "sentra.show", { sessionId: SESSION_A, id: row.id });
      const other = await call(storeWith(), "sentra.show", { sessionId: SESSION_B, id: row.id });

      expect(showResultSchema.parse(shown.result)).toMatchObject({ type: "item" });
      expect(other.error).toBe(
        `not_found: No Sentra record or issue "${row.id}" in session ${SESSION_B}.`,
      );
    });

    it("requires an id", async () => {
      const res = await call(storeWith(), "sentra.show", { sessionId: SESSION_A });
      expect(res.error).toMatch(/^invalid_filter: /);
    });
  });

  describe("sentra.clear", () => {
    it("clears only the session", async () => {
      const sentra = await seeded();
      const res = await call(storeWith(), "sentra.clear", { sessionId: SESSION_A });
      expect(res.result).toEqual({ itemsDeleted: 1 });
      const left = await sentra.query.listItems({ session: SESSION_B });
      expect(left.items).toHaveLength(1);
    });

    it("zeroes the matching error counters", async () => {
      const sentra = await seeded();
      const store = storeWith();
      const since = Date.now() - 60_000;
      store.sentraCounter.reset(SESSION_A, "web", since);
      store.sentraCounter.reset(SESSION_A, "api", since);
      store.sentraCounter.attach(SESSION_A, () => undefined);
      await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "a" } });
      await ingestEvent(sentra, { service: "api", error: { type: "Error", value: "b" } });

      await call(store, "sentra.clear", { sessionId: SESSION_A, service: ["web"] });
      expect(store.sentraCounter.get(SESSION_A, "web")).toBe(0);
      expect(store.sentraCounter.get(SESSION_A, "api")).toBe(1);
    });
  });

  it("returns non-query errors as plain messages", async () => {
    const sentra = await seeded();
    sentra.query.listIssues = async () => Promise.reject(new Error("disk gone"));
    const res = await call(storeWith(), "sentra.issues", { sessionId: SESSION_A });
    expect(res.error).toBe("disk gone");
  });
});
