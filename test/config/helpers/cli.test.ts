import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../../../src/config/errors.js";
import { createCliHelpers, createStderrSink } from "../../../src/config/helpers/cli.js";
import type { ConfigNotice } from "../../../src/config/types.js";

describe("createCliHelpers", () => {
  it("fatal throws ConfigError(kind:fatal) with the field passthrough", () => {
    const notices: ConfigNotice[] = [];
    const cli = createCliHelpers((n) => notices.push(n));
    let caught: unknown;
    try {
      cli.fatal("boom", { field: "services.api" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toMatchObject({ kind: "fatal", field: "services.api" });
    // Does NOT route through the sink.
    expect(notices).toHaveLength(0);
  });

  it("fatal without opts leaves field undefined", () => {
    const cli = createCliHelpers(vi.fn());
    expect(() => cli.fatal("boom")).toThrow(ConfigError);
    try {
      cli.fatal("boom");
    } catch (error) {
      expect((error as ConfigError).field).toBeUndefined();
    }
  });

  it("warn/info/success emit a ConfigNotice through the sink and return void", () => {
    const notices: ConfigNotice[] = [];
    const cli = createCliHelpers((n) => notices.push(n));
    expect(cli.warn("w")).toBeUndefined();
    expect(cli.info("i")).toBeUndefined();
    expect(cli.success("s")).toBeUndefined();
    expect(notices).toEqual([
      { level: "warn", message: "w" },
      { level: "info", message: "i" },
      { level: "success", message: "s" },
    ]);
  });
});

describe("createStderrSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a styled line per level to stderr", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const sink = createStderrSink();
    sink({ level: "warn", message: "careful" });
    sink({ level: "info", message: "fyi" });
    sink({ level: "success", message: "done" });

    expect(writes).toHaveLength(3);
    expect(writes[0]).toContain("⚠");
    expect(writes[0]).toContain("careful");
    expect(writes[1]).toContain("ℹ");
    expect(writes[1]).toContain("fyi");
    expect(writes[2]).toContain("✔");
    expect(writes[2]).toContain("done");
  });
});
