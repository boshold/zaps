import { describe, expect, it } from "vitest";

import { canTransition, createServiceStatus, transition } from "../../../src/lib/service/state.js";
import type { ServiceState } from "../../../src/lib/service/types.js";

describe("canTransition", () => {
  const ALL_STATES: ServiceState[] = [
    "stopped",
    "starting",
    "ready",
    "stopping",
    "error",
    "restarting",
    "unavailable",
  ];

  // Canonical transition table — kept in sync with VALID_TRANSITIONS in state.ts.
  const VALID: Record<ServiceState, ServiceState[]> = {
    stopped: ["starting"],
    starting: ["ready", "error", "stopping"],
    ready: ["stopping", "restarting", "error"],
    stopping: ["stopped"],
    error: ["starting"],
    restarting: ["starting", "stopping", "error"],
    unavailable: [],
  };

  // Exhaustive 7x7 matrix — every from/to pair asserted valid or invalid.
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const expected = VALID[from].includes(to);
      it(`${from} -> ${to} is ${expected ? "valid" : "invalid"}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it("includes the new restarting -> stopping and restarting -> error edges", () => {
    expect(canTransition("restarting", "stopping")).toBe(true);
    expect(canTransition("restarting", "error")).toBe(true);
    expect(canTransition("restarting", "starting")).toBe(true);
  });

  it("keeps unavailable terminal (no transitions in or out)", () => {
    for (const to of ALL_STATES) {
      expect(canTransition("unavailable", to)).toBe(false);
    }
    for (const from of ALL_STATES) {
      expect(canTransition(from, "unavailable")).toBe(false);
    }
  });

  it("returns false for unknown state key", () => {
    expect(canTransition("bogus" as never, "ready")).toBe(false);
  });
});

describe("transition", () => {
  it("returns the new state on valid input", () => {
    expect(transition("stopped", "starting")).toBe("starting");
    expect(transition("starting", "ready")).toBe("ready");
    expect(transition("ready", "stopping")).toBe("stopping");
  });

  it("throws on invalid input", () => {
    expect(() => transition("stopped", "ready")).toThrow(
      "Invalid state transition: stopped \u2192 ready",
    );
    expect(() => transition("error", "stopped")).toThrow(
      "Invalid state transition: error \u2192 stopped",
    );
  });
});

describe("createServiceStatus", () => {
  it("returns correct defaults", () => {
    const status = createServiceStatus("api");
    expect(status).toEqual({
      name: "api",
      state: "stopped",
      ports: [],
      retryCount: 0,
    });
  });
});
