import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAuxPort, probePort, selectProbeCandidates } from "../../src/lib/probe.js";

function mockFetch(responses: Record<string, number | "throw">): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input as string;
    const value = responses[url];
    if (value === undefined || value === "throw") {
      throw new Error("Connection refused");
    }
    return new Response(null, { status: value });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probePort", () => {
  it("returns undefined for empty port list", async () => {
    expect(await probePort([])).toBeUndefined();
  });

  it("returns undefined when no listener responds", async () => {
    mockFetch({});
    expect(await probePort([19_999])).toBeUndefined();
  });

  it("targets 127.0.0.1 (B8)", async () => {
    const spy = mockFetch({ "http://127.0.0.1:3000": 200 });
    expect(await probePort([3000])).toBe("http://127.0.0.1:3000");
    expect(spy).toHaveBeenCalledWith(
      "http://127.0.0.1:3000",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("falls back to [::1] when 127.0.0.1 is refused (B8)", async () => {
    mockFetch({ "http://[::1]:3000": 200 });
    expect(await probePort([3000])).toBe("http://[::1]:3000");
  });

  it("accepts a 4xx/5xx-only port when it is the only candidate", async () => {
    mockFetch({ "http://127.0.0.1:3000": 403 });
    expect(await probePort([3000])).toBe("http://127.0.0.1:3000");
  });

  it("prefers a 2xx/3xx port over a lower port answering only 4xx (B7)", async () => {
    mockFetch({ "http://127.0.0.1:3000": 403, "http://127.0.0.1:8080": 200 });
    expect(await probePort([3000, 8080])).toBe("http://127.0.0.1:8080");
  });

  it("skips the Node inspector port when an app port is present (B7)", async () => {
    const spy = mockFetch({ "http://127.0.0.1:9229": 200, "http://127.0.0.1:3000": 200 });
    expect(await probePort([9229, 3000])).toBe("http://127.0.0.1:3000");
    expect(spy).not.toHaveBeenCalledWith("http://127.0.0.1:9229", expect.anything());
  });

  it("probes an aux port when it is the only one (no brick)", async () => {
    mockFetch({ "http://127.0.0.1:24678": 200 });
    expect(await probePort([24_678])).toBe("http://127.0.0.1:24678");
  });

  it("returns undefined when all ports fail", async () => {
    mockFetch({});
    expect(await probePort([5432, 3000, 8080])).toBeUndefined();
  });
});

describe("isAuxPort", () => {
  it("flags the Node inspector range 9229-9240", () => {
    expect(isAuxPort(9229)).toBe(true);
    expect(isAuxPort(9240)).toBe(true);
    expect(isAuxPort(9228)).toBe(false);
    expect(isAuxPort(9241)).toBe(false);
  });
  it("flags the Vite HMR port 24678", () => {
    expect(isAuxPort(24_678)).toBe(true);
  });
  it("does not flag a typical app port", () => {
    expect(isAuxPort(3000)).toBe(false);
  });
});

describe("selectProbeCandidates", () => {
  it("drops aux ports when non-aux ports exist", () => {
    expect(selectProbeCandidates([9229, 3000, 24_678])).toEqual([3000]);
  });
  it("keeps aux ports when they are the only ones", () => {
    expect(selectProbeCandidates([9229, 24_678])).toEqual([9229, 24_678]);
  });
});
