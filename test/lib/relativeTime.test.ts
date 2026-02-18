import { describe, expect, it, vi } from "vitest";

import { relativeTime } from "../../src/lib/relativeTime.js";

describe("relativeTime", () => {
  it("returns 'just now' for timestamps less than 60s ago", () => {
    expect(relativeTime(Date.now() - 30_000)).toBe("just now");
    expect(relativeTime(Date.now())).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(relativeTime(Date.now() - 60_000)).toBe("1m ago");
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(Date.now() - 59 * 60_000)).toBe("59m ago");
  });

  it("returns hours ago", () => {
    expect(relativeTime(Date.now() - 60 * 60_000)).toBe("1h ago");
    expect(relativeTime(Date.now() - 3 * 60 * 60_000)).toBe("3h ago");
    expect(relativeTime(Date.now() - 23 * 60 * 60_000)).toBe("23h ago");
  });

  it("returns days ago", () => {
    expect(relativeTime(Date.now() - 24 * 60 * 60_000)).toBe("1d ago");
    expect(relativeTime(Date.now() - 7 * 24 * 60 * 60_000)).toBe("7d ago");
  });

  it("uses Date.now() internally", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));
    const timestamp = Date.now() - 120_000; // 2 minutes ago
    expect(relativeTime(timestamp)).toBe("2m ago");
    vi.useRealTimers();
  });
});
