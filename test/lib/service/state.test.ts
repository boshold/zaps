import { describe, expect, it } from "vitest";

import { canTransition, createServiceStatus, transition } from "../../../src/lib/service/state.js";
import type { ServiceState } from "../../../src/lib/service/types.js";

describe("canTransition", () => {
  const validTransitions: [ServiceState, ServiceState][] = [
    ["stopped", "starting"],
    ["starting", "ready"],
    ["starting", "error"],
    ["starting", "stopping"],
    ["ready", "stopping"],
    ["ready", "restarting"],
    ["ready", "error"],
    ["stopping", "stopped"],
    ["error", "starting"],
    ["restarting", "starting"],
  ];

  for (const [from, to] of validTransitions) {
    it(`${from} -> ${to} is valid`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  const invalidTransitions: [ServiceState, ServiceState][] = [
    ["stopped", "ready"],
    ["stopped", "error"],
    ["stopped", "stopping"],
    ["stopped", "restarting"],
    ["starting", "starting"],
    ["starting", "restarting"],
    ["ready", "starting"],
    ["ready", "ready"],
    ["stopping", "starting"],
    ["stopping", "ready"],
    ["stopping", "error"],
    ["error", "stopped"],
    ["error", "ready"],
    ["error", "stopping"],
    ["restarting", "stopped"],
    ["restarting", "ready"],
    ["restarting", "error"],
  ];

  for (const [from, to] of invalidTransitions) {
    it(`${from} -> ${to} is invalid`, () => {
      expect(canTransition(from, to)).toBe(false);
    });
  }
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
