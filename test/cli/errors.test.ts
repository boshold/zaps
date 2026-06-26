import { describe, expect, it, vi } from "vitest";

import { renderCliError } from "../../src/cli/errors.js";
import { ConfigError } from "../../src/config/errors.js";

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
