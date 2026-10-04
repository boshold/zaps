import type { LiveEvent, Sentra } from "@bosdev/sentra-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { ErrorCounter, isCountedError } from "#src/lib/sentra/counter.js";
import { errorRowSchema } from "#src/lib/sentra/schemas.js";

import { SESSION_A, SESSION_B, ingestEvent, memorySentra } from "../../_helpers/sentra.js";

let sentra: Sentra;
let counter: ErrorCounter;
let events: DaemonEvent[];

beforeEach(async () => {
  sentra = await memorySentra();
  counter = new ErrorCounter(sentra);
  events = [];
});

afterEach(async () => {
  await sentra.close();
});

function attachA(): void {
  counter.attach(SESSION_A, (event) => events.push(event));
}

describe("isCountedError", () => {
  it("counts error/message records at level error or fatal only", () => {
    for (const kind of ["error", "message"] as const) {
      expect(isCountedError({ kind, level: "error" })).toBe(true);
      expect(isCountedError({ kind, level: "fatal" })).toBe(true);
      expect(isCountedError({ kind, level: "warning" })).toBe(false);
      expect(isCountedError({ kind, level: "info" })).toBe(false);
      expect(isCountedError({ kind, level: null })).toBe(false);
    }
    expect(isCountedError({ kind: "log", level: "error" })).toBe(false);
    expect(isCountedError({ kind: "transaction", level: "fatal" })).toBe(false);
  });
});

describe("ErrorCounter", () => {
  it("returns null for services that never started with Sentra", () => {
    expect(counter.get(SESSION_A, "web")).toBeNull();
  });

  it("counts matching records per service since the last start", async () => {
    attachA();
    counter.reset(SESSION_A, "web", Date.now() - 1000);
    counter.reset(SESSION_A, "api", Date.now() - 1000);

    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "boom" } });
    await ingestEvent(sentra, { service: "web", message: "bad", level: "fatal" });
    await ingestEvent(sentra, { service: "web", message: "fyi", level: "info" });
    await ingestEvent(sentra, {
      service: "web",
      level: "warning",
      error: { type: "W", value: "w" },
    });
    await ingestEvent(sentra, { service: "api", message: "oops", level: "error" });
    await ingestEvent(sentra, { service: "other", error: { type: "Error", value: "x" } });
    await ingestEvent(sentra, {
      session: SESSION_B,
      service: "web",
      error: { type: "E", value: "y" },
    });

    expect(counter.get(SESSION_A, "web")).toBe(2);
    expect(counter.get(SESSION_A, "api")).toBe(1);
    expect(counter.get(SESSION_A, "other")).toBeNull();
    expect(counter.get(SESSION_B, "web")).toBeNull();
  });

  it("ignores records received before `since`", async () => {
    attachA();
    counter.reset(SESSION_A, "web", Date.now() + 60_000);
    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "old" } });
    expect(counter.get(SESSION_A, "web")).toBe(0);
  });

  it("resets the count on restart", async () => {
    attachA();
    counter.reset(SESSION_A, "web", Date.now() - 1000);
    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "a" } });
    expect(counter.get(SESSION_A, "web")).toBe(1);

    counter.reset(SESSION_A, "web", Date.now() - 1000);
    expect(counter.get(SESSION_A, "web")).toBe(0);
  });

  it("subscribes once per session", () => {
    const subscribe = vi.fn(() => vi.fn());
    const fake = new ErrorCounter({ subscribe });
    fake.attach(SESSION_A, vi.fn());
    fake.attach(SESSION_A, vi.fn());
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({ session: SESSION_A }, expect.any(Function));
  });

  it("detach unsubscribes and drops the session's counters", async () => {
    attachA();
    counter.reset(SESSION_A, "web", Date.now() - 1000);
    counter.reset(SESSION_B, "web", Date.now() - 1000);
    counter.detach(SESSION_A);

    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "late" } });
    expect(events).toEqual([]);
    expect(counter.get(SESSION_A, "web")).toBeNull();
    expect(counter.get(SESSION_B, "web")).toBe(0);
  });

  it("clear zeroes the given services or all of the session", async () => {
    attachA();
    counter.reset(SESSION_A, "web", Date.now() - 1000);
    counter.reset(SESSION_A, "api", Date.now() - 1000);
    counter.reset(SESSION_B, "web", Date.now() - 1000);
    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "a" } });
    await ingestEvent(sentra, { service: "api", error: { type: "Error", value: "b" } });

    counter.clear(SESSION_A, ["web"]);
    expect(counter.get(SESSION_A, "web")).toBe(0);
    expect(counter.get(SESSION_A, "api")).toBe(1);

    counter.clear(SESSION_A);
    expect(counter.get(SESSION_A, "api")).toBe(0);
    expect(counter.get(SESSION_B, "web")).toBe(0);
  });

  it("broadcasts sentra.item with an ErrorRow and the live line", async () => {
    attachA();
    await ingestEvent(sentra, {
      service: "web",
      error: {
        type: "TypeError",
        value: "nope",
        frames: [{ filename: "/app/src/a.ts", function: "run", lineno: 3, colno: 7 }],
      },
    });
    await ingestEvent(sentra, { service: "web", message: "fyi", level: "info" });

    expect(events).toHaveLength(2);
    const [first] = events;
    expect(first).toMatchObject({ session: SESSION_A, event: "sentra.item" });
    const data = first?.data;
    expect(data).toEqual({ row: expect.any(Object), line: expect.any(String) });
    const row = errorRowSchema.parse((data as { row: unknown }).row);
    expect(row).toMatchObject({ service: "web", kind: "error", title: "TypeError: nope" });
    expect(row.location).toContain("a.ts");
    const { line } = data as { line: string };
    expect(line).toContain("web error TypeError: nope");
    expect(line).toContain(`at ${row.location}`);
  });

  it("broadcasts sentra.failed for failed envelopes", () => {
    let listener: ((event: LiveEvent) => void) | null = null;
    const fake = new ErrorCounter({
      subscribe: (_filter, fn) => {
        listener = fn;
        return vi.fn();
      },
    });
    const broadcast = vi.fn();
    fake.attach(SESSION_A, broadcast);
    const emit = listener as ((event: LiveEvent) => void) | null;
    emit?.({
      type: "envelope.failed",
      error: "bad gzip",
      envelope: {
        id: "env1",
        scope: { project: "proj", session: SESSION_A, service: "web" },
        receivedAt: new Date().toISOString(),
        header: {},
        size: 1,
        contentEncoding: null,
        itemCount: 0,
        parseError: "bad gzip",
        parseWarnings: [],
      },
    });
    expect(broadcast).toHaveBeenCalledWith({
      session: SESSION_A,
      event: "sentra.failed",
      data: { error: "bad gzip" },
    });
  });
});
