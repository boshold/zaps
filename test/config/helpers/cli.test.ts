import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../../../src/config/errors.js";
import { createCliHelpers, createStderrSink } from "../../../src/config/helpers/cli.js";
import type { ConfigNotice } from "../../../src/config/types.js";

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
    vi.unstubAllEnvs();
  });

  function captureStderr(): string[] {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    return writes;
  }

  it("emits bold glyph + colored message per level on a TTY without NO_COLOR", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const writes = captureStderr();
    const sink = createStderrSink();
    withStderrTTY(true, () => {
      sink({ level: "warn", message: "careful" });
      sink({ level: "info", message: "fyi" });
      sink({ level: "success", message: "done" });
    });
    expect(writes).toEqual([
      "\n  \x1b[1m\x1b[33m⚠\x1b[39m\x1b[22m \x1b[33mcareful\x1b[39m\n",
      "\n  \x1b[1m\x1b[34mℹ\x1b[39m\x1b[22m \x1b[34mfyi\x1b[39m\n",
      "\n  \x1b[1m\x1b[32m✔\x1b[39m\x1b[22m \x1b[32mdone\x1b[39m\n",
    ]);
  });

  it("emits no ANSI when NO_COLOR is set, even on a TTY stderr", () => {
    vi.stubEnv("NO_COLOR", "1");
    const writes = captureStderr();
    const sink = createStderrSink();
    withStderrTTY(true, () => sink({ level: "warn", message: "careful" }));
    expect(writes).toEqual(["\n  ⚠ careful\n"]);
  });

  it("emits no ANSI when stderr is not a TTY", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const writes = captureStderr();
    const sink = createStderrSink();
    withStderrTTY(false, () => sink({ level: "info", message: "fyi" }));
    expect(writes).toEqual(["\n  ℹ fyi\n"]);
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
