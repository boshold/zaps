import { SentraValidationError } from "@boshold/sentra-core";
import type { Item, PageInput, Sentra } from "@boshold/sentra-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WALK,
  SentraQueryError,
  clearSession,
  itemLocation,
  listErrors,
  listIssues,
  showById,
} from "#src/lib/sentra/query.js";
import type { SentraQuerySource } from "#src/lib/sentra/query.js";

import { SESSION_A, SESSION_B, ingestEvent, memorySentra } from "../../_helpers/sentra.js";

let sentra: Sentra;

beforeEach(async () => {
  sentra = await memorySentra();
});

afterEach(async () => {
  vi.useRealTimers();
  await sentra.close();
});

async function ingestErrors(count: number, extra: { service?: string; session?: string } = {}) {
  for (let index = 0; index < count; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- keep receive order
    await ingestEvent(sentra, { ...extra, error: { type: "Error", value: `e${index}` } });
  }
}

/** Caps every page at 2 rows so cursors are walked. */
function smallPages(source: Sentra): void {
  const listItems = source.query.listItems.bind(source.query);
  const listIssuesFn = source.query.listIssues.bind(source.query);
  const cap = (page: PageInput | undefined) => ({ ...page, limit: Math.min(2, page?.limit ?? 2) });
  vi.spyOn(source.query, "listItems").mockImplementation(async (filter, page) =>
    listItems(filter, cap(page)),
  );
  vi.spyOn(source.query, "listIssues").mockImplementation(async (filter, page) =>
    listIssuesFn(filter, cap(page)),
  );
}

async function expectQueryError(promise: Promise<unknown>, code: string, message: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(SentraQueryError);
  const text = await promise.catch(String);
  expect(text).toMatch(new RegExp(`^${code}: `));
  expect(text).toMatch(message);
}

describe("listErrors", () => {
  it("defaults to error/message at min level error", async () => {
    await ingestEvent(sentra, { error: { type: "TypeError", value: "boom" } });
    await ingestEvent(sentra, { message: "info msg", level: "info" });
    await ingestEvent(sentra, { message: "bad msg", level: "error" });

    const result = await listErrors(sentra, { sessionId: SESSION_A });

    expect(result.hasMore).toBe(false);
    expect(result.errors.map((row) => row.title)).toEqual(["bad msg", "TypeError: boom"]);
    expect(result.errors[1]).toMatchObject({
      service: "web",
      kind: "error",
      level: "error",
      location: "",
    });
    expect(result.errors[1]?.issueId).toEqual(expect.any(String));
  });

  it("drops the level default when kind is given", async () => {
    await ingestEvent(sentra, { message: "info msg", level: "info" });
    await ingestEvent(sentra, { error: { type: "TypeError", value: "boom" } });

    const result = await listErrors(sentra, { sessionId: SESSION_A, kind: ["message"] });

    expect(result.errors.map((row) => row.title)).toEqual(["info msg"]);
  });

  it("keeps the kind default when only a level flag is given", async () => {
    await ingestEvent(sentra, { message: "warn msg", level: "warning" });
    await ingestEvent(sentra, { message: "info msg", level: "info" });

    const byMin = await listErrors(sentra, { sessionId: SESSION_A, minLevel: "warning" });
    const byLevel = await listErrors(sentra, { sessionId: SESSION_A, level: ["info"] });

    expect(byMin.errors.map((row) => row.title)).toEqual(["warn msg"]);
    expect(byLevel.errors.map((row) => row.title)).toEqual(["info msg"]);
  });

  it("pages with skip/limit across cursor boundaries", async () => {
    await ingestErrors(7);
    smallPages(sentra);

    const first = await listErrors(sentra, { sessionId: SESSION_A, limit: 3 });
    const middle = await listErrors(sentra, { sessionId: SESSION_A, skip: 3, limit: 3 });
    const last = await listErrors(sentra, { sessionId: SESSION_A, skip: 6, limit: 3 });

    expect(first.errors.map((row) => row.title)).toEqual(["Error: e6", "Error: e5", "Error: e4"]);
    expect(first.hasMore).toBe(true);
    expect(middle.errors.map((row) => row.title)).toEqual(["Error: e3", "Error: e2", "Error: e1"]);
    expect(middle.hasMore).toBe(true);
    expect(last.errors.map((row) => row.title)).toEqual(["Error: e0"]);
    expect(last.hasMore).toBe(false);
  });

  it("reports hasMore false when the page exactly fits", async () => {
    await ingestErrors(4);
    smallPages(sentra);

    const result = await listErrors(sentra, { sessionId: SESSION_A, skip: 1, limit: 3 });

    expect(result.errors).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });

  it("rejects skip + limit beyond the walk cap", async () => {
    await expectQueryError(
      listErrors(sentra, { sessionId: SESSION_A, skip: MAX_WALK, limit: 1 }),
      "invalid_filter",
      /--skip too large/,
    );
  });

  it("filters by receivedAt time window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
    await ingestEvent(sentra, { error: { type: "Error", value: "early" } });
    vi.setSystemTime(new Date("2026-10-04T11:00:00Z"));
    await ingestEvent(sentra, { error: { type: "Error", value: "middle" } });
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    await ingestEvent(sentra, { error: { type: "Error", value: "late" } });

    const window = await listErrors(sentra, {
      sessionId: SESSION_A,
      from: "2026-10-04T10:30:00Z",
      to: Date.parse("2026-10-04T11:30:00Z"),
    });
    const since = await listErrors(sentra, { sessionId: SESSION_A, since: "90m" });

    expect(window.errors.map((row) => row.title)).toEqual(["Error: middle"]);
    expect(since.errors.map((row) => row.title)).toEqual(["Error: late", "Error: middle"]);
  });

  it("rejects since together with from", async () => {
    await expectQueryError(
      listErrors(sentra, { sessionId: SESSION_A, since: "1m", from: "1m" }),
      "invalid_filter",
      /--since and --from cannot be combined/,
    );
  });

  it("scopes to the session and services", async () => {
    await ingestEvent(sentra, { service: "api", error: { type: "Error", value: "api" } });
    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "web" } });
    await ingestEvent(sentra, { session: SESSION_B, error: { type: "Error", value: "other" } });

    const api = await listErrors(sentra, { sessionId: SESSION_A, service: ["api"] });
    const all = await listErrors(sentra, { sessionId: SESSION_A, service: [] });

    expect(api.errors.map((row) => row.title)).toEqual(["Error: api"]);
    expect(all.errors.map((row) => row.title)).toEqual(["Error: web", "Error: api"]);
  });

  it("extracts the newest in-app frame as location", async () => {
    await ingestEvent(sentra, {
      error: {
        type: "TypeError",
        value: "boom",
        frames: [
          { filename: "/app/outer.ts", lineno: 3, colno: 5 },
          { filename: "/app/inner.ts", lineno: 9, colno: 2 },
          { filename: "node:internal/x", lineno: 1, inApp: false },
        ],
      },
    });

    const result = await listErrors(sentra, { sessionId: SESSION_A });

    expect(result.errors[0]?.location).toBe("/app/inner.ts:9:2");
  });

  it("maps sentra validation errors to invalid_filter", async () => {
    const failing: SentraQuerySource = {
      clear: sentra.clear,
      query: {
        ...sentra.query,
        listItems: async () => Promise.reject(new SentraValidationError("invalid_filter", "bad q")),
      },
    };

    await expectQueryError(
      listErrors(failing, { sessionId: SESSION_A }),
      "invalid_filter",
      /bad q/,
    );
  });

  it("rethrows other errors untouched", async () => {
    const failing: SentraQuerySource = {
      clear: sentra.clear,
      query: { ...sentra.query, listItems: async () => Promise.reject(new Error("disk gone")) },
    };

    await expect(listErrors(failing, { sessionId: SESSION_A })).rejects.toThrow("disk gone");
  });
});

describe("itemLocation", () => {
  it("returns empty for missing items and non-event kinds", () => {
    expect(itemLocation(null)).toBe("");
  });

  it("falls back to the newest frame without in-app frames and to message stacktraces", async () => {
    await ingestEvent(sentra, {
      error: {
        type: "Error",
        value: "lib",
        frames: [
          { filename: "/lib/a.js", lineno: 1, inApp: false },
          { filename: "/lib/b.js", lineno: 2, colno: 3, inApp: false },
        ],
      },
    });
    const page = await sentra.query.listItems({ session: SESSION_A });
    const item = await sentra.query.getItem(page.items[0]?.id ?? "");
    expect(itemLocation(item)).toBe("/lib/b.js:2:3");

    if (item?.kind !== "error") {
      throw new Error("expected error item");
    }
    const frame = item.data.exceptions[0]?.frames[0];
    if (!frame) {
      throw new Error("expected frame");
    }
    const message: Item = {
      ...item,
      kind: "message",
      data: { ...item.data, exceptions: [], stacktrace: [frame] },
    };
    expect(itemLocation(message)).toBe("/lib/a.js:1:1");
    const log: Item = {
      ...item,
      kind: "log",
      data: { body: "x", severityNumber: null, spanId: null, attributes: {} },
    };
    expect(itemLocation(log)).toBe("");
  });
});

describe("listIssues", () => {
  it("returns issue rows with joined services", async () => {
    await ingestEvent(sentra, { service: "web", error: { type: "TypeError", value: "same" } });
    await ingestEvent(sentra, { service: "api", error: { type: "TypeError", value: "same" } });
    await ingestEvent(sentra, { session: SESSION_B, error: { type: "TypeError", value: "same" } });

    const result = await listIssues(sentra, { sessionId: SESSION_A });

    expect(result.hasMore).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      title: "TypeError: same",
      level: "error",
      count: 2,
      shortId: expect.any(String),
    });
    expect(result.issues[0]?.services.split(",").toSorted()).toEqual(["api", "web"]);
  });

  it("pages across cursor boundaries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-04T10:00:00Z");
    for (const [index, word] of ["alpha", "bravo", "charlie", "delta", "echo"].entries()) {
      vi.setSystemTime(start + index * 1000);
      // oxlint-disable-next-line no-await-in-loop -- distinct lastSeen order
      await ingestEvent(sentra, { message: word, level: "error" });
    }
    smallPages(sentra);

    const page = await listIssues(sentra, { sessionId: SESSION_A, skip: 1, limit: 3 });
    const tail = await listIssues(sentra, { sessionId: SESSION_A, skip: 4, limit: 3 });

    expect(page.issues.map((row) => row.title)).toEqual(["delta", "charlie", "bravo"]);
    expect(page.hasMore).toBe(true);
    expect(tail.issues.map((row) => row.title)).toEqual(["alpha"]);
    expect(tail.hasMore).toBe(false);
  });

  it("filters by level and time window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
    await ingestEvent(sentra, { message: "old", level: "error" });
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    await ingestEvent(sentra, { message: "new warn", level: "warning" });
    await ingestEvent(sentra, { message: "new err", level: "error" });

    const recent = await listIssues(sentra, { sessionId: SESSION_A, since: "1h" });
    const errorsOnly = await listIssues(sentra, { sessionId: SESSION_A, minLevel: "error" });

    expect(recent.issues.map((row) => row.title)).toEqual(["new err", "new warn"]);
    expect(errorsOnly.issues.map((row) => row.title)).toEqual(["new err", "old"]);
  });
});

describe("showById", () => {
  it("resolves item ids, issue ids and event ids", async () => {
    const eventId = await ingestEvent(sentra, { error: { type: "TypeError", value: "boom" } });
    const { errors } = await listErrors(sentra, { sessionId: SESSION_A });
    const [row] = errors;
    if (!row?.issueId) {
      throw new Error("expected row with issue");
    }

    const byItem = await showById(sentra, SESSION_A, row.id);
    const byIssue = await showById(sentra, SESSION_A, row.issueId);
    const byEvent = await showById(sentra, SESSION_A, eventId.toUpperCase());

    expect(byItem.type).toBe("item");
    expect(byItem.markdown).toContain("TypeError: boom");
    expect(byIssue.type).toBe("issue");
    expect(byIssue.markdown).toContain("TypeError: boom");
    expect(byEvent).toMatchObject({ type: "item", item: { id: row.id } });
  });

  it("treats other sessions as not found", async () => {
    const eventId = await ingestEvent(sentra, { error: { type: "Error", value: "x" } });
    const { errors } = await listErrors(sentra, { sessionId: SESSION_A });
    const [row] = errors;
    if (!row?.issueId) {
      throw new Error("expected row with issue");
    }

    for (const id of [row.id, row.issueId, eventId, "missing"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      await expectQueryError(
        showById(sentra, SESSION_B, id),
        "not_found",
        new RegExp(`No Sentra record or issue "${id}" in session ${SESSION_B}\\.`),
      );
    }
  });

  it("prefers error records for a shared event id", async () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    await ingestEvent(sentra, { eventId, message: "msg", level: "error" });
    await ingestEvent(sentra, { eventId, error: { type: "Error", value: "err" } });

    const result = await showById(sentra, SESSION_A, eventId);

    expect(result.type === "item" && result.item.kind).toBe("error");
  });
});

describe("clearSession", () => {
  it("clears only the given service of the session", async () => {
    await ingestEvent(sentra, { service: "web", error: { type: "Error", value: "web" } });
    await ingestEvent(sentra, { service: "api", error: { type: "Error", value: "api" } });
    await ingestEvent(sentra, { session: SESSION_B, error: { type: "Error", value: "b" } });

    const result = await clearSession(sentra, { sessionId: SESSION_A, service: ["web"] });

    expect(result).toEqual({ itemsDeleted: 1 });
    const left = await listErrors(sentra, { sessionId: SESSION_A });
    expect(left.errors.map((row) => row.title)).toEqual(["Error: api"]);
    const other = await listErrors(sentra, { sessionId: SESSION_B });
    expect(other.errors).toHaveLength(1);
  });

  it("clears records received before `to`", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
    await ingestEvent(sentra, { error: { type: "Error", value: "old" } });
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    await ingestEvent(sentra, { error: { type: "Error", value: "new" } });

    const result = await clearSession(sentra, { sessionId: SESSION_A, to: "1h" });

    expect(result).toEqual({ itemsDeleted: 1 });
    const left = await listErrors(sentra, { sessionId: SESSION_A });
    expect(left.errors.map((row) => row.title)).toEqual(["Error: new"]);
  });

  it("rejects an invalid `to` with the --before message", async () => {
    await expectQueryError(
      clearSession(sentra, { sessionId: SESSION_A, to: "soon" }),
      "invalid_filter",
      /Invalid --before: "soon"/,
    );
  });
});
