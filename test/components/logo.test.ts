import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGO, renderSplash } from "../../src/components/logo.js";

describe("LOGO", () => {
  it("is a non-empty string", () => {
    expect(typeof LOGO).toBe("string");
    expect(LOGO.length).toBeGreaterThan(0);
  });

  it("contains ZAPS text", () => {
    // The logo is an ASCII art containing the letters
    expect(LOGO).toContain("╗");
    expect(LOGO).toContain("║");
  });
});

describe("renderSplash", () => {
  let writeSpy: MockInstance;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("writes to stdout", () => {
    renderSplash({ cols: 80, rows: 24 });
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("\x1b[H"); // Cursor home
  });

  it("uses provided dimensions", () => {
    renderSplash({ cols: 100, rows: 30 });
    const output = writeSpy.mock.calls[0][0] as string;
    // Should contain size label at bottom
    expect(output).toContain("100x30");
  });

  it("uses defaults when no dimensions provided", () => {
    renderSplash();
    expect(writeSpy).toHaveBeenCalled();
  });

  it("includes subtitle text", () => {
    renderSplash({ cols: 80, rows: 24 });
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("Starting services...");
  });

  it("handles small terminal size", () => {
    renderSplash({ cols: 20, rows: 5 });
    expect(writeSpy).toHaveBeenCalled();
    // Should not throw even with tiny terminal
  });
});
