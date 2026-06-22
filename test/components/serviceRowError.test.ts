import { describe, expect, it } from "vitest";

import { showsErrorSubRow, showsInlineError } from "../../src/components/serviceRowError.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return { name: "api", state: "ready", ports: [], retryCount: 0, ...overrides };
}

describe("showsErrorSubRow", () => {
  it("is false without a lastError", () => {
    expect(showsErrorSubRow(makeStatus({ state: "error" }), true)).toBe(false);
  });

  it("is true for the selected row", () => {
    expect(showsErrorSubRow(makeStatus({ state: "ready", lastError: "x" }), true)).toBe(true);
  });

  it("is true for an unselected errored/stopped row (C4)", () => {
    expect(showsErrorSubRow(makeStatus({ state: "error", lastError: "x" }), false)).toBe(true);
    expect(showsErrorSubRow(makeStatus({ state: "stopped", lastError: "x" }), false)).toBe(true);
  });

  it("is false for an unselected non-failed row with a lingering error", () => {
    expect(showsErrorSubRow(makeStatus({ state: "starting", lastError: "x" }), false)).toBe(false);
  });
});

describe("showsInlineError", () => {
  const errored = makeStatus({ state: "error", lastError: "boom" });

  it("suppresses the inline row when the detail pane is visible (wide)", () => {
    expect(showsInlineError(errored, true, true)).toBe(false);
    expect(showsInlineError(errored, false, true)).toBe(false);
  });

  it("keeps the inline row when there is no detail pane (narrow)", () => {
    expect(showsInlineError(errored, true, false)).toBe(true);
    expect(showsInlineError(errored, false, false)).toBe(true);
  });
});
