import { describe, expect, it } from "vitest";

import { newRunId } from "../../../src/lib/task/run-id.js";

describe("newRunId", () => {
  it("returns a prefixed, non-empty id", () => {
    const id = newRunId();
    expect(id.startsWith("run_")).toBe(true);
    expect(id.length).toBeGreaterThan("run_".length);
  });

  it("generates a distinct id on every call (correlates concurrent runs)", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRunId()));
    expect(ids.size).toBe(100);
  });
});
