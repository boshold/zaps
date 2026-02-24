import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open", () => ({ default: vi.fn() }));

import open from "open";

import { openInBrowser } from "../../src/lib/open.js";

const mockOpen = vi.mocked(open);

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openInBrowser", () => {
  it("calls open when fetch succeeds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    mockOpen.mockResolvedValue(undefined as never);

    await openInBrowser("http://localhost:3000");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3000",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(mockOpen).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("silently ignores when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await openInBrowser("http://localhost:3000");

    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("silently ignores when open throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    mockOpen.mockRejectedValue(new Error("open failed"));

    await expect(openInBrowser("http://localhost:3000")).resolves.toBeUndefined();
  });
});
