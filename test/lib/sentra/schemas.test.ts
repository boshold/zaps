import { describe, expect, it } from "vitest";

import {
  errorsParamsSchema,
  issuesParamsSchema,
  showResultSchema,
  statusResultSchema,
} from "#src/lib/sentra/schemas.js";

describe("sentra schemas", () => {
  it("requires a 12-hex sessionId", () => {
    expect(errorsParamsSchema.safeParse({ sessionId: "abc" }).success).toBe(false);
    expect(errorsParamsSchema.safeParse({ sessionId: "0123456789ab" }).success).toBe(true);
  });

  it("validates levels, kinds and paging bounds", () => {
    const base = { sessionId: "0123456789ab" };
    expect(errorsParamsSchema.safeParse({ ...base, level: ["loud"] }).success).toBe(false);
    expect(errorsParamsSchema.safeParse({ ...base, kind: ["log", "span"] }).success).toBe(true);
    expect(issuesParamsSchema.safeParse({ ...base, limit: 501 }).success).toBe(false);
    expect(issuesParamsSchema.safeParse({ ...base, skip: -1 }).success).toBe(false);
    expect(issuesParamsSchema.safeParse({ ...base, from: 5, to: "1h" }).success).toBe(true);
  });

  it("parses show and status results", () => {
    expect(
      showResultSchema.safeParse({ type: "item", item: { id: "x" }, markdown: "# x" }).success,
    ).toBe(true);
    expect(showResultSchema.safeParse({ type: "issue", issue: null, markdown: "" }).success).toBe(
      false,
    );
    expect(
      statusResultSchema.safeParse({
        enabled: null,
        state: "stopped",
        port: null,
        dbPath: "/x",
        reason: null,
        services: [],
      }).success,
    ).toBe(true);
  });
});
