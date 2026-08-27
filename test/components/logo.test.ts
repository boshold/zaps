import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOGO,
  LOGO_ASCII,
  MANAGED_TMUX_HINT,
  managedSplashHint,
  renderSplash,
} from "../../src/components/logo.js";

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

  function firstNonAscii(s: string): number {
    for (let i = 0; i < s.length; i += 1) {
      if (s.charCodeAt(i) > 127) {
        return i;
      }
    }
    return -1;
  }

  it("renders a strictly 7-bit splash under the ascii tier", () => {
    renderSplash({ cols: 80, rows: 24 }, "ascii");
    const output = writeSpy.mock.calls[0][0] as string;
    expect(firstNonAscii(output)).toBe(-1);
  });

  it("ascii logo art is itself pure 7-bit", () => {
    expect(firstNonAscii(LOGO_ASCII)).toBe(-1);
    expect(LOGO_ASCII.length).toBeGreaterThan(0);
  });

  it("handles small terminal size", () => {
    renderSplash({ cols: 20, rows: 5 });
    expect(writeSpy).toHaveBeenCalled();
    // Should not throw even with tiny terminal
  });

  it("renders the managed hint below the subtitle when given one", () => {
    renderSplash({ cols: 100, rows: 30 }, undefined, MANAGED_TMUX_HINT);
    const output = writeSpy.mock.calls[0][0] as string;
    const lines = output.split("\n");
    const subtitleRow = lines.findIndex((l) => l.includes("Starting services..."));
    expect(lines[subtitleRow + 1]).toContain(MANAGED_TMUX_HINT);
  });

  it("omits the hint line when there is none", () => {
    renderSplash({ cols: 100, rows: 30 });
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("auto-tmux");
  });

  it("drops the hint rather than overwriting the size label on a short pane", () => {
    renderSplash({ cols: 100, rows: 9 }, undefined, MANAGED_TMUX_HINT);
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("100x9");
  });
});

describe("managedSplashHint", () => {
  it("shows the hint only in managed mode", () => {
    expect(managedSplashHint("1")).toBe(MANAGED_TMUX_HINT);
    expect(managedSplashHint("0")).toBeUndefined();
    expect(managedSplashHint(undefined)).toBeUndefined();
  });
});
