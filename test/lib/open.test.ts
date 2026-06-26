import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open", () => ({ default: vi.fn() }));

import open from "open";

import { openInBrowser } from "../../src/lib/open.js";

const mockOpen = vi.mocked(open);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("openInBrowser", () => {
  it("opens the url directly, without a reachability preflight", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockOpen.mockResolvedValue(undefined as never);

    await openInBrowser("http://localhost:3000");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("rejects when open fails so callers can surface it", async () => {
    mockOpen.mockRejectedValue(new Error("open failed"));

    await expect(openInBrowser("http://localhost:3000")).rejects.toThrow("open failed");
  });
});
