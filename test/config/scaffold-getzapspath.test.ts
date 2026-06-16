import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const resolveMock = vi.fn();

// Mock node:module so we can drive createRequire().resolve deterministically and
// Exercise both the resolution-success and fallback branches of getZapsPath (G8).
vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: resolveMock }),
}));

const { getZapsPath } = await import("../../src/config/scaffold.js");

describe("getZapsPath (G8)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the package directory when zaps/package.json resolves", () => {
    const pkgJson = path.join("/opt", "global", "node_modules", "zaps", "package.json");
    resolveMock.mockReturnValue(pkgJson);
    expect(getZapsPath()).toBe(path.dirname(pkgJson));
    expect(resolveMock).toHaveBeenCalledWith("zaps/package.json");
  });

  it("falls back to the bare 'zaps' specifier when resolution throws", () => {
    resolveMock.mockImplementation(() => {
      throw new Error("Cannot find module 'zaps/package.json'");
    });
    expect(getZapsPath()).toBe("zaps");
  });
});
