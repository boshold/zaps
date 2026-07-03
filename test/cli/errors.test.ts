import { afterEach, describe, expect, it, vi } from "vitest";

import { renderCliError } from "../../src/cli/errors.js";
import { ConfigError } from "../../src/config/errors.js";

/** Runs `fn` with `process.stderr.isTTY` forced to `isTTY`, then restores. */
function withStderrTTY<T>(isTTY: boolean, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stderr, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
    }
  }
}

function makeDeps() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writes,
    exits,
    deps: {
      write: (text: string) => {
        writes.push(text);
      },
      exit: ((code: number) => {
        exits.push(code);
        return undefined as never;
      }) as (code: number) => never,
    },
  };
}

describe("renderCliError", () => {
  it("styles a ConfigError with a ✖ prefix and exits 1", () => {
    const { writes, exits, deps } = makeDeps();
    renderCliError(new ConfigError("bad config", { kind: "validation" }), deps);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("✖");
    expect(writes[0]).toContain("bad config");
    expect(exits).toEqual([1]);
  });

  it("renders a plain Error without the ✖ prefix and exits 1", () => {
    const { writes, exits, deps } = makeDeps();
    renderCliError(new Error("plain boom"), deps);
    expect(writes).toEqual(["plain boom\n"]);
    expect(writes[0]).not.toContain("✖");
    expect(exits).toEqual([1]);
  });

  it("stringifies a non-Error value and exits 1", () => {
    const { writes, exits, deps } = makeDeps();
    renderCliError("just a string", deps);
    expect(writes).toEqual(["just a string\n"]);
    expect(exits).toEqual([1]);
  });

  describe("color handling", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("emits bold-red ✖ ANSI when stderr is a TTY and NO_COLOR is unset", () => {
      vi.stubEnv("NO_COLOR", undefined);
      const { writes, deps } = makeDeps();
      withStderrTTY(true, () =>
        renderCliError(new ConfigError("bad config", { kind: "validation" }), deps),
      );
      expect(writes[0]).toBe("\n  \x1b[1m\x1b[31m✖\x1b[39m\x1b[22m \x1b[31mbad config\x1b[39m\n");
    });

    it("emits no ANSI when NO_COLOR is set, even on a TTY stderr", () => {
      vi.stubEnv("NO_COLOR", "1");
      const { writes, deps } = makeDeps();
      withStderrTTY(true, () =>
        renderCliError(new ConfigError("bad config", { kind: "validation" }), deps),
      );
      expect(writes[0]).toBe("\n  ✖ bad config\n");
      expect(writes[0]).not.toContain("\x1b[");
    });

    it("emits no ANSI when stderr is not a TTY", () => {
      vi.stubEnv("NO_COLOR", undefined);
      const { writes, deps } = makeDeps();
      withStderrTTY(false, () =>
        renderCliError(new ConfigError("bad config", { kind: "validation" }), deps),
      );
      expect(writes[0]).toBe("\n  ✖ bad config\n");
      expect(writes[0]).not.toContain("\x1b[");
    });
  });

  it("uses default deps (process.stderr + process.exit) when none injected", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    renderCliError(new Error("default path"));
    expect(writeSpy).toHaveBeenCalledWith("default path\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
