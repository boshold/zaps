import { describe, expect, it } from "vitest";

import {
  SentraQueryError,
  parseSinceInput,
  parseTimeInput,
  resolveTimeWindow,
} from "#src/lib/sentra/time.js";

const NOW = 1_700_000_000_000;

describe("parseTimeInput", () => {
  it("keeps ISO 8601 strings", () => {
    expect(parseTimeInput("2026-10-04T10:00:00Z")).toBe("2026-10-04T10:00:00Z");
    expect(parseTimeInput("2026-10-04")).toBe("2026-10-04");
  });

  it("parses epoch ms strings and numbers", () => {
    expect(parseTimeInput("1700000000000")).toBe(1_700_000_000_000);
    expect(parseTimeInput(42)).toBe(42);
  });

  it("turns durations into now minus duration", () => {
    expect(parseTimeInput("10m", "from", NOW)).toBe(NOW - 600_000);
    expect(parseTimeInput("2h", "to", NOW)).toBe(NOW - 7_200_000);
  });

  it("rejects invalid input with the CLI message", () => {
    expect(() => parseTimeInput("yesterday")).toThrow(
      'Invalid --from: "yesterday". Use ISO 8601, epoch ms, or a duration like 10m.',
    );
    expect(() => parseTimeInput("2026-99-99T00:00:00Z", "to")).toThrow('Invalid --to: "2026-99-99');
    expect(() => parseTimeInput(-1)).toThrow(SentraQueryError);
    expect(() => parseTimeInput(Number.NaN)).toThrow(SentraQueryError);
  });

  it("uses invalid_filter code", () => {
    try {
      parseTimeInput("nope");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SentraQueryError);
      expect(String(error)).toMatch(/^invalid_filter: Invalid --from/);
    }
  });
});

describe("parseSinceInput", () => {
  it("accepts durations only", () => {
    expect(parseSinceInput("30s", NOW)).toBe(NOW - 30_000);
    expect(() => parseSinceInput("2026-10-04")).toThrow('Invalid --since: "2026-10-04"');
  });
});

describe("resolveTimeWindow", () => {
  it("maps since to from", () => {
    expect(resolveTimeWindow({ since: "1m", to: "2026-10-04" }, NOW)).toEqual({
      from: NOW - 60_000,
      to: "2026-10-04",
    });
  });

  it("passes from through the parser", () => {
    expect(resolveTimeWindow({ from: "5m" }, NOW)).toEqual({ from: NOW - 300_000 });
    expect(resolveTimeWindow({}, NOW)).toEqual({});
  });

  it("rejects since with from", () => {
    expect(() => resolveTimeWindow({ since: "1m", from: 1 })).toThrow(
      "--since and --from cannot be combined.",
    );
  });
});
