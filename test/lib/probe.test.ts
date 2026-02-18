import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probePort } from "../../src/lib/probe.js";

// ---------- tests ----------

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("probePort", () => {
  it("returns undefined for empty port list", async () => {
    expect(await probePort([])).toBeUndefined();
  });

  it("returns undefined for port with no listener", async () => {
    expect(await probePort([19_999])).toBeUndefined();
  });

  describe("HTTP GET probe", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns http URL when server responds to HTTP GET", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());

      const result = await probePort([3000]);
      expect(result).toBe("http://localhost:3000");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3000",
        expect.objectContaining({ method: "GET", redirect: "manual" }),
      );
    });

    it("returns http URL even for 4xx/5xx responses", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

      const result = await probePort([3000]);
      expect(result).toBe("http://localhost:3000");
    });

    it("returns undefined when fetch throws", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

      const result = await probePort([3000]);
      expect(result).toBeUndefined();
    });
  });

  describe("multi-port selection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns first HTTP port", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(new Response());

      const result = await probePort([5432, 3000]);
      expect(result).toBe("http://localhost:3000");
    });
  });
});
