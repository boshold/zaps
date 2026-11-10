import { describe, expect, it } from "vitest";

import {
  StartupArgumentError,
  parseStartupArguments,
  selectStartupBackend,
} from "../../src/cli/backend-selection.js";
import type { StartupIntent } from "../../src/cli/backend-selection.js";
import type { BackendId } from "../../src/lib/backend/types.js";

function intent(overrides: Partial<StartupIntent> = {}): StartupIntent {
  return { explicitBackend: undefined, background: false, detach: false, ...overrides };
}

function startup(argv: readonly string[]) {
  const parsed = parseStartupArguments(argv);
  expect(parsed.kind).toBe("startup");
  if (parsed.kind !== "startup") {
    throw new Error("Expected startup arguments");
  }
  return parsed;
}

function expectError(action: () => unknown, code: string) {
  expect(action).toThrow(StartupArgumentError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe("startup backend selection", () => {
  const cases: readonly {
    existing: BackendId | undefined;
    explicit: BackendId | undefined;
    foregroundBackend: BackendId | undefined;
    backgroundBackend: BackendId | undefined;
  }[] = [
    {
      existing: undefined,
      explicit: undefined,
      foregroundBackend: "tmux",
      backgroundBackend: "shell",
    },
    {
      existing: undefined,
      explicit: "shell",
      foregroundBackend: "shell",
      backgroundBackend: "shell",
    },
    { existing: undefined, explicit: "tmux", foregroundBackend: "tmux", backgroundBackend: "tmux" },
    {
      existing: "shell",
      explicit: undefined,
      foregroundBackend: "shell",
      backgroundBackend: "shell",
    },
    { existing: "tmux", explicit: undefined, foregroundBackend: "tmux", backgroundBackend: "tmux" },
    {
      existing: "shell",
      explicit: "shell",
      foregroundBackend: "shell",
      backgroundBackend: "shell",
    },
    { existing: "tmux", explicit: "tmux", foregroundBackend: "tmux", backgroundBackend: "tmux" },
    {
      existing: "shell",
      explicit: "tmux",
      foregroundBackend: undefined,
      backgroundBackend: undefined,
    },
    {
      existing: "tmux",
      explicit: "shell",
      foregroundBackend: undefined,
      backgroundBackend: undefined,
    },
  ];
  const uiCases = [
    { background: false, detach: false, attachUi: true },
    { background: true, detach: false, attachUi: false },
    { background: false, detach: true, attachUi: false },
    { background: true, detach: true, attachUi: false },
  ];
  for (const { existing, explicit, foregroundBackend, backgroundBackend } of cases) {
    for (const { background, detach, attachUi } of uiCases) {
      it(`existing=${existing}, explicit=${explicit}, background=${background}, detach=${detach}`, () => {
        const requested = intent({ explicitBackend: explicit, background, detach });
        const backend = background ? backgroundBackend : foregroundBackend;
        if (backend === undefined) {
          expectError(() => selectStartupBackend(requested, existing), "backend_conflict");
          expect(() => selectStartupBackend(requested, existing)).toThrow("zaps down");
        } else {
          expect(selectStartupBackend(requested, existing)).toEqual({ backend, attachUi });
        }
      });
    }
  }

  it("opens the existing shell UI after background startup", () => {
    const first = selectStartupBackend(startup(["-b"]).intent, undefined);
    expect(first).toEqual({ backend: "shell", attachUi: false });
    expect(selectStartupBackend(startup([]).intent, first.backend)).toEqual({
      backend: "shell",
      attachUi: true,
    });
  });
});

describe("startup argument normalization", () => {
  it.each([[], ["up"]])("keeps default intent explicit for %j", (...argv) => {
    expect(startup(argv)).toEqual({ kind: "startup", argv: ["up"], intent: intent() });
  });

  it.each([
    ["-b"],
    ["--background"],
    ["up", "-b"],
    ["-b", "up"],
    ["--background", "up"],
    ["up", "--background"],
  ])("accepts background startup %j", (...argv) => {
    expect(startup(argv).intent).toEqual(intent({ background: true }));
  });

  it.each([
    ["-B", "shell"],
    ["--backend", "shell"],
    ["--backend=shell"],
    ["-B=shell"],
    ["up", "-B", "shell"],
    ["-B", "shell", "up"],
    ["--backend:shell"],
    ["-B.shell"],
  ])("accepts backend startup %j", (...argv) => {
    expect(startup(argv).intent).toEqual(intent({ explicitBackend: "shell" }));
  });

  it.each([
    ["-b", "-B", "tmux"],
    ["-B", "tmux", "-b"],
    ["-b", "up", "--backend=tmux"],
    ["--backend=tmux", "up", "--background"],
    ["up", "-B", "tmux", "--backend=tmux", "-b"],
  ])("explicit backend wins in %j", (...argv) => {
    expect(selectStartupBackend(startup(argv).intent, undefined)).toEqual({
      backend: "tmux",
      attachUi: false,
    });
  });

  it.each([
    ["up", "-d"],
    ["up", "--detach"],
    ["-b", "up", "-d"],
    ["-B", "shell", "up", "--detach"],
    ["up", "-ds", "app"],
  ])("retains detach scope in %j", (...argv) => {
    expect(startup(argv).intent.detach).toBe(true);
  });

  it.each([
    { argv: ["-s", "foo", "-b", "up"], normalized: ["-s", "foo", "up", "-b"] },
    { argv: ["-b", "-s", "foo", "up"], normalized: ["up", "-b", "-s", "foo"] },
    { argv: ["-B", "shell", "-s", "foo", "up"], normalized: ["up", "-B", "shell", "-s", "foo"] },
    { argv: ["--session=up", "-b", "up"], normalized: ["--session=up", "up", "-b"] },
    { argv: ["-s", "-b", "-B", "shell", "up"], normalized: ["-s", "-b", "up", "-B", "shell"] },
    { argv: ["-s", "--", "-b"], normalized: ["-s", "--", "up", "-b"] },
    {
      argv: ["-s", "first", "-b", "up", "-s", "last"],
      normalized: ["-s", "first", "up", "-b", "-s", "last"],
    },
    {
      argv: ["-s", "one", "--session", "two", "-b"],
      normalized: ["-s", "one", "--session", "two", "up", "-b"],
    },
  ])("preserves selector ownership for $argv", ({ argv, normalized }) => {
    const parsed = startup(argv);
    expect(parsed.argv).toEqual(normalized);
    expect(parsed.argv).not.toBe(argv);
  });

  it.each([["--background=false"], ["up", "--detach=false"], ["-b=false"]])(
    "honors inline false %j",
    (...argv) => {
      expect(startup(argv).intent).toEqual(intent());
    },
  );

  it("retains the terminator and literal arguments", () => {
    expect(startup(["up", "--", "-b", "-B", "shell"])).toEqual({
      kind: "startup",
      argv: ["up", "--", "-b", "-B", "shell"],
      intent: intent(),
    });
  });
});

describe("startup argument failures", () => {
  it.each([
    ["-B"],
    ["up", "--backend"],
    ["-B", "--help"],
    ["-B", "-b"],
    ["-B", "shell", "--backend=tmux"],
    ["up", "-B=tmux", "-B=shell"],
    ["-d", "up"],
    ["--detach", "up"],
    ["-b", "-d"],
    ["-d", "-b", "up"],
    ["-bB", "shell"],
    ["up", "-db"],
    ["-Bshell"],
    ["up", "-Bshell"],
    ["-b", "--unknown"],
    ["up", "-s"],
  ])("rejects invalid request %j", (...argv) => {
    expectError(() => parseStartupArguments(argv), "invalid_request");
  });

  it.each([["-B", "up"], ["-B", "unknown"], ["--backend="], ["up", "-B=Shell"]])(
    "validates backend names %j",
    (...argv) => {
      expectError(() => parseStartupArguments(argv), "invalid_backend");
    },
  );

  it.each(["ps", "attach", "run", "daemon", "sentra", "ui", "exec-service", "mcp"])(
    "rejects startup flags around %s",
    (command) => {
      for (const flags of [["-b"], ["-B", "shell"]]) {
        expectError(() => parseStartupArguments([...flags, command]), "invalid_request");
        expectError(() => parseStartupArguments([command, ...flags]), "invalid_request");
      }
    },
  );
});

describe("existing CLI ownership", () => {
  it.each([
    ["--help"],
    ["-h"],
    ["help"],
    ["help", "up"],
    ["up", "--help"],
    ["--version"],
    ["-V"],
    ["-s", "foo"],
    ["-s", "-b"],
    ["--session=--backend"],
    ["-d"],
    ["--detach"],
    ["ps"],
    ["daemon", "status", "--help"],
    ["sentra", "search", "--query=-b"],
    ["logs", "--tail=--backend"],
    ["run", "--", "-b"],
    ["run", "--", "-B", "shell"],
    ["mcp", "--session", "up"],
    ["logs", "--tail", "up"],
    ["up", "-b", "--help"],
    ["-b", "--help"],
    ["-B", "shell", "-V"],
  ])("preserves dispatch %j", (...argv) => {
    const original = [...argv];
    const parsed = parseStartupArguments(argv);
    expect(parsed).toEqual({ kind: "dispatch", argv: original });
    expect(parsed.argv).not.toBe(argv);
    expect(argv).toEqual(original);
  });
});
