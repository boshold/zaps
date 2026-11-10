import { beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "#src/cli/helpers.js";
import { matchesLive, withLiveDefaults } from "#src/cli/sentra-live.js";
import type { LiveDeps, LiveHandlers } from "#src/cli/sentra-live.js";
import {
  createAutoStartRequest,
  resolveSessionFor,
  runSentraCli,
  runSentraCommand,
} from "#src/cli/sentra.js";
import type { SentraCliDeps, SentraFlags } from "#src/cli/sentra.js";
import type { DaemonEvent, IpcResponse } from "#src/lib/ipc/protocol.js";
import type { ErrorRow } from "#src/lib/sentra/schemas.js";

const RUNNING = { id: "aaaaaaaaaaaa", name: "proj", projectDir: "/work/proj" };
const OTHER = { id: "bbbbbbbbbbbb", name: "other", projectDir: "/work/other" };

const ROW: ErrorRow = {
  id: "01928f3a-6c1e-7b2a-9f4d-2c8e1a7b5d10",
  receivedAt: "2026-10-03T14:02:11.204Z",
  service: "web",
  kind: "error",
  level: "error",
  title: "TypeError: boom",
  location: "a.ts:1",
  issueId: "i1",
};

type Handler = (params: unknown) => IpcResponse;

function setup(handlers: Record<string, Handler> = {}, overrides: Partial<SentraCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const request = vi.fn(async (method: string, params?: unknown): Promise<IpcResponse> => {
    if (method === "session.list") {
      return { id: "1", result: [RUNNING, OTHER] };
    }
    const handler = handlers[method];
    return handler ? handler(params) : { id: "1", error: `Unknown method: ${method}` };
  });
  const deps: SentraCliDeps = {
    request,
    cwd: () => "/work/proj/sub",
    configSessionId: () => "cccccccccccc",
    argv: ["sentra", "errors", "--limit", "1"],
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { deps, request, out: () => out.join(""), err: () => err.join("") };
}

function lastParams(request: ReturnType<typeof setup>["request"], method: string): unknown {
  const calls = request.mock.calls.filter(([name]) => name === method);
  return calls.at(-1)?.[1];
}

const ok =
  (result: unknown): Handler =>
  () => ({ id: "1", result });
const fail =
  (error: string): Handler =>
  () => ({ id: "1", error });

describe("resolveSessionFor", () => {
  it("uses the running session of the cwd", async () => {
    const { deps } = setup();
    expect(await resolveSessionFor(deps, undefined)).toBe(RUNNING.id);
  });

  it("falls back to the cwd config id when nothing runs there", async () => {
    const { deps } = setup({}, { cwd: () => "/elsewhere" });
    expect(await resolveSessionFor(deps, undefined)).toBe("cccccccccccc");
  });

  it("resolves -s by name or prefix, and accepts a stopped 12-hex id", async () => {
    const { deps } = setup();
    expect(await resolveSessionFor(deps, "other")).toBe(OTHER.id);
    expect(await resolveSessionFor(deps, "dddddddddddd")).toBe("dddddddddddd");
    await expect(resolveSessionFor(deps, "nope")).rejects.toThrow("Session not found: nope");
  });

  it("propagates config and list errors", async () => {
    const noConfig = setup(
      {},
      {
        cwd: () => "/elsewhere",
        configSessionId: () => {
          throw new CliError("No .zaps.mts config found. Run `zaps init` to create one.");
        },
      },
    );
    await expect(resolveSessionFor(noConfig.deps, undefined)).rejects.toThrow(
      "No .zaps.mts config found",
    );
    const broken = setup({}, { request: async () => ({ id: "1", error: "boom" }) });
    await expect(resolveSessionFor(broken.deps, undefined)).rejects.toThrow("Error: boom");
  });
});

describe("zaps sentra errors", () => {
  it("prints TOON with a next hint built from the typed argv", async () => {
    const t = setup({ "sentra.errors": ok({ errors: [ROW], hasMore: true }) });
    const code = await runSentraCli(["errors", "--limit", "1"], t.deps);
    expect(code).toBe(0);
    expect(t.out()).toContain(
      "errors[1]{id,receivedAt,service,kind,level,title,location,issueId}:",
    );
    expect(t.out()).toContain("next: zaps sentra errors --limit 1 --skip 1\n");
    expect(lastParams(t.request, "sentra.errors")).toEqual({
      sessionId: RUNNING.id,
      limit: 1,
      skip: 0,
    });
  });

  it("maps every filter flag to IPC params", async () => {
    const t = setup({ "sentra.errors": ok({ errors: [], hasMore: false }) });
    const code = await runSentraCli(
      [
        "errors",
        "-s",
        "other",
        "--service",
        "web",
        "--service",
        "api",
        "--level",
        "error",
        "--min-level",
        "warning",
        "--kind",
        "error, log",
        "--q",
        "boom",
        "--release",
        "1.0",
        "--environment",
        "dev",
        "--trace-id",
        "t1",
        "--from",
        "2026-10-03T14:00:00Z",
        "--to",
        "1700000000000",
        "--skip",
        "5",
      ],
      t.deps,
    );
    expect(code).toBe(0);
    expect(t.out()).toBe("errors[0]:\n");
    expect(lastParams(t.request, "sentra.errors")).toEqual({
      sessionId: OTHER.id,
      service: ["web", "api"],
      level: ["error"],
      minLevel: "warning",
      kind: ["error", "log"],
      q: "boom",
      release: "1.0",
      environment: "dev",
      traceId: "t1",
      from: "2026-10-03T14:00:00Z",
      to: 1_700_000_000_000,
      limit: 20,
      skip: 5,
    });
  });

  it("resolves --since to an absolute from", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const t = setup({ "sentra.errors": ok({ errors: [], hasMore: false }) });
    await runSentraCli(["errors", "--since", "10s"], t.deps);
    expect(lastParams(t.request, "sentra.errors")).toMatchObject({ from: 990_000 });
    vi.restoreAllMocks();
  });

  it("prints JSON with --json or ZAPS_FORMAT=json", async () => {
    const result = { errors: [ROW], hasMore: false };
    const flag = setup({ "sentra.errors": ok(result) });
    await runSentraCli(["errors", "--json"], flag.deps);
    expect(JSON.parse(flag.out())).toEqual(result);

    const env = setup({ "sentra.errors": ok(result) }, { env: { ZAPS_FORMAT: "json" } });
    await runSentraCli(["errors"], env.deps);
    expect(JSON.parse(env.out())).toEqual(result);
  });

  it("exits 1 with --fail-if-any after printing", async () => {
    const hit = setup({ "sentra.errors": ok({ errors: [ROW], hasMore: false }) });
    expect(await runSentraCli(["errors", "--fail-if-any"], hit.deps)).toBe(1);
    expect(hit.out()).toContain("TypeError: boom");

    const none = setup({ "sentra.errors": ok({ errors: [], hasMore: false }) });
    expect(await runSentraCli(["errors", "--fail-if-any"], none.deps)).toBe(0);
  });

  it.each([
    [
      ["--from", "nonsense"],
      'Invalid --from: "nonsense". Use ISO 8601, epoch ms, or a duration like 10m.',
    ],
    [["--since", "1m", "--from", "1m"], "--since and --from cannot be combined."],
    [
      ["--level", "loud"],
      'Invalid --level "loud". Use one of: trace, debug, info, warning, error, fatal.',
    ],
    [
      ["--min-level", "x"],
      'Invalid --min-level "x". Use one of: trace, debug, info, warning, error, fatal.',
    ],
    [["--kind", "error,bogus"], 'Invalid --kind "bogus". Use one of:'],
    [["--limit", "501"], 'Invalid --limit "501". Use an integer from 1 to 500.'],
    [["--skip=-1"], 'Invalid --skip "-1". Use an integer >= 0.'],
  ])("rejects %j with exit 2", async (flags, message) => {
    const t = setup();
    expect(await runSentraCli(["errors", ...flags], t.deps)).toBe(2);
    expect(t.err()).toContain(`Error: ${message}`);
    expect(t.request).not.toHaveBeenCalled();
  });

  it.each([
    [
      'sentra_disabled: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.',
      'Error: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.',
      1,
    ],
    ["sentra_unavailable: port busy", "Error: Sentra is unavailable: port busy", 1],
    ["invalid_filter: --skip too large", "Error: --skip too large", 2],
    ["not_found: nope", "Error: nope", 1],
    ["Unknown method: sentra.errors", "Error: This daemon is older than the CLI.", 1],
    ["weird", "Error: weird", 1],
  ])("maps daemon error %j", async (daemonError, message, code) => {
    const t = setup({ "sentra.errors": fail(daemonError) });
    expect(await runSentraCli(["errors"], t.deps)).toBe(code);
    expect(t.err()).toContain(message);
  });

  it("reports runtime errors with exit 1", async () => {
    const t = setup(
      {},
      { request: async () => Promise.reject(new CliError("Daemon not running.")) },
    );
    expect(await runSentraCommand("errors", {}, t.deps)).toBe(1);
    expect(t.err()).toBe("Error: Daemon not running.\n");
  });

  it("uses the root-level session argument", async () => {
    const t = setup(
      { "sentra.errors": ok({ errors: [], hasMore: false }) },
      { sessionArg: "other" },
    );
    await runSentraCli(["errors"], t.deps);
    expect(lastParams(t.request, "sentra.errors")).toMatchObject({ sessionId: OTHER.id });
  });
});

describe("zaps sentra issues", () => {
  const issue = {
    id: "i1",
    shortId: "P-1",
    services: "web",
    level: "error",
    title: "boom",
    culprit: null,
    count: 2,
    firstSeen: "2026-10-03T14:00:00.000Z",
    lastSeen: "2026-10-03T14:01:00.000Z",
  };

  it("prints TOON with next hint and maps flags", async () => {
    const t = setup(
      { "sentra.issues": ok({ issues: [issue], hasMore: true }) },
      { argv: ["sentra", "issues", "--skip=2"] },
    );
    expect(
      await runSentraCli(["issues", "--skip=2", "--min-level", "error", "--q=bo"], t.deps),
    ).toBe(0);
    expect(t.out()).toContain(
      "issues[1]{id,shortId,services,level,title,culprit,count,firstSeen,lastSeen}:",
    );
    expect(t.out()).toContain("next: zaps sentra issues --skip 22");
    expect(lastParams(t.request, "sentra.issues")).toEqual({
      sessionId: RUNNING.id,
      minLevel: "error",
      q: "bo",
      limit: 20,
      skip: 2,
    });
  });

  it("prints JSON", async () => {
    const t = setup({ "sentra.issues": ok({ issues: [], hasMore: false }) });
    await runSentraCli(["issues", "--json"], t.deps);
    expect(JSON.parse(t.out())).toEqual({ issues: [], hasMore: false });
  });

  it("propagates daemon errors", async () => {
    const t = setup({ "sentra.issues": fail("invalid_filter: bad") });
    expect(await runSentraCli(["issues", "--level", "error"], t.deps)).toBe(2);
  });
});

describe("zaps sentra show", () => {
  const item = { type: "item", item: { id: "x" }, markdown: "# Item" };

  it("prints markdown", async () => {
    const t = setup({ "sentra.show": ok(item) });
    expect(await runSentraCli(["show", "x"], t.deps)).toBe(0);
    expect(t.out()).toBe("# Item\n");
    expect(lastParams(t.request, "sentra.show")).toEqual({ sessionId: RUNNING.id, id: "x" });
  });

  it("prints JSON without markdown", async () => {
    const t = setup({ "sentra.show": ok(item) });
    await runSentraCli(["show", "x", "--json"], t.deps);
    expect(JSON.parse(t.out())).toEqual({ type: "item", item: { id: "x" } });

    const issue = setup({
      "sentra.show": ok({ type: "issue", issue: { id: "i" }, markdown: "# Issue\n" }),
    });
    await runSentraCli(["show", "i", "--json"], issue.deps);
    expect(JSON.parse(issue.out())).toEqual({ type: "issue", issue: { id: "i" } });
    const md = setup({
      "sentra.show": ok({ type: "issue", issue: { id: "i" }, markdown: "# Issue\n" }),
    });
    await runSentraCli(["show", "i"], md.deps);
    expect(md.out()).toBe("# Issue\n");
  });

  it("requires an id (exit 2) and maps not_found (exit 1)", async () => {
    const missing = setup();
    expect(await runSentraCli(["show"], missing.deps)).toBe(2);
    expect(missing.err()).toBe("Error: Missing <id>. Usage: zaps sentra show <id>\n");

    const notFound = setup({
      "sentra.show": fail('not_found: No Sentra record or issue "x" in session aaaaaaaaaaaa.'),
    });
    expect(await runSentraCli(["show", "x"], notFound.deps)).toBe(1);
    expect(notFound.err()).toBe('Error: No Sentra record or issue "x" in session aaaaaaaaaaaa.\n');
  });
});

describe("zaps sentra clear", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the count and maps --before", async () => {
    const t = setup({ "sentra.clear": ok({ itemsDeleted: 3 }) });
    expect(
      await runSentraCli(["clear", "--service", "web", "--before", "2026-10-03T14:00:00Z"], t.deps),
    ).toBe(0);
    expect(t.out()).toBe("Cleared 3 records.\n");
    expect(lastParams(t.request, "sentra.clear")).toEqual({
      sessionId: RUNNING.id,
      service: ["web"],
      to: "2026-10-03T14:00:00Z",
    });
  });

  it("prints JSON and validates --before", async () => {
    const t = setup({ "sentra.clear": ok({ itemsDeleted: 0 }) });
    await runSentraCli(["clear", "--json"], t.deps);
    expect(JSON.parse(t.out())).toEqual({ itemsDeleted: 0 });

    const bad = setup();
    expect(await runSentraCli(["clear", "--before", "soon"], bad.deps)).toBe(2);
    expect(bad.err()).toContain('Invalid --before: "soon"');
  });

  it("propagates daemon errors", async () => {
    const t = setup({ "sentra.clear": fail("sentra_unavailable: x") });
    expect(await runSentraCli(["clear"], t.deps)).toBe(1);
  });
});

describe("zaps sentra group", () => {
  it("rejects unknown commands", async () => {
    const t = setup();
    expect(await runSentraCli(["bogus"], t.deps)).toBe(1);
    expect(t.err()).toBe("error: unknown command 'bogus'\n");
  });
});

describe("createAutoStartRequest", () => {
  it("starts the daemon and retries once when it is not running", async () => {
    const request = vi
      .fn<(sock: string, method: string, params?: unknown) => Promise<IpcResponse>>()
      .mockRejectedValueOnce(new CliError("Daemon not running."))
      .mockResolvedValueOnce({ id: "1", result: "ok" });
    const ensureDaemon = vi.fn(async () => "/new.sock");
    const send = createAutoStartRequest({ request, socket: () => "/old.sock", ensureDaemon });

    await expect(send("sentra.errors", { a: 1 })).resolves.toEqual({ id: "1", result: "ok" });
    expect(ensureDaemon).toHaveBeenCalledOnce();
    expect(request.mock.calls).toEqual([
      ["/old.sock", "sentra.errors", { a: 1 }],
      ["/new.sock", "sentra.errors", { a: 1 }],
    ]);
  });

  it("does not retry other errors or a second failure", async () => {
    const ensureDaemon = vi.fn(async () => "/new.sock");
    const other = createAutoStartRequest({
      request: async () => Promise.reject(new Error("EACCES")),
      socket: () => "/s",
      ensureDaemon,
    });
    await expect(other("m")).rejects.toThrow("EACCES");
    expect(ensureDaemon).not.toHaveBeenCalled();

    const twice = createAutoStartRequest({
      request: async () => Promise.reject(new CliError("Daemon not running.")),
      socket: () => "/s",
      ensureDaemon,
    });
    await expect(twice("m")).rejects.toThrow("Daemon not running.");
    expect(ensureDaemon).toHaveBeenCalledOnce();
  });
});

function fakeHandlers(): LiveHandlers {
  return { onEvent: () => undefined, onSubscribed: () => undefined, onEnd: () => undefined };
}

describe("zaps sentra live", () => {
  const STATUS = {
    enabled: true,
    state: "running",
    port: 4100,
    dbPath: "/s.db",
    reason: null,
    services: ["web"],
  };

  interface FakeSub {
    sessionId: string;
    handlers: LiveHandlers;
    closed: boolean;
  }

  function fakeLive() {
    const subs: FakeSub[] = [];
    const sleeps: (() => void)[] = [];
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const live: LiveDeps = {
      subscribe: vi.fn((sessionId: string, handlers: LiveHandlers) => {
        const sub: FakeSub = { sessionId, handlers, closed: false };
        subs.push(sub);
        return {
          close: () => {
            sub.closed = true;
          },
        };
      }),
      request: vi.fn<LiveDeps["request"]>(),
      sleep: vi.fn(
        async (_ms: number) =>
          new Promise<void>((resolve) => {
            sleeps.push(resolve);
          }),
      ),
      waitForStop: async () => stopped,
    };
    return { live, subs, sleeps, stop: () => stop() };
  }

  function item(row: Partial<ErrorRow>, line = "LINE"): DaemonEvent {
    return { session: RUNNING.id, event: "sentra.item", data: { row: { ...ROW, ...row }, line } };
  }

  /** Live IPC answers from `handlers`; the auto-starting `deps.request` must stay unused. */
  function liveSetup(handlers: Record<string, Handler>) {
    const fake = fakeLive();
    const autoStart = vi.fn<SentraCliDeps["request"]>();
    const ctx = setup(handlers, { live: fake.live, request: autoStart });
    vi.mocked(fake.live.request).mockImplementation(ctx.request);
    return { ...fake, ...ctx, autoStart };
  }

  function start(flags: SentraFlags = {}, status: unknown = STATUS) {
    const ctx = liveSetup({ "sentra.status": ok(status) });
    const done = runSentraCommand("live", flags, ctx.deps);
    return { ...ctx, done };
  }

  it("prints matching lines with default filters and exits 0 on Ctrl-C", async () => {
    const run = start();
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    expect(run.subs[0]?.sessionId).toBe(RUNNING.id);
    const { onEvent, onSubscribed } = run.subs[0]?.handlers ?? fakeHandlers();
    onSubscribed();
    onEvent(item({ title: "boom" }, "14:02:11 web error boom"));
    onEvent(item({ kind: "message", level: "warning" }, "warn line"));
    onEvent(item({ kind: "message", level: "info" }, "info line"));
    onEvent(item({ kind: "log", level: "error" }, "log line"));
    onEvent({ session: RUNNING.id, event: "sentra.item", data: { row: { id: 1 } } });
    onEvent({ session: RUNNING.id, event: "service.stateChange", data: {} });
    onEvent({ session: RUNNING.id, event: "sentra.failed", data: { error: "bad gzip" } });

    run.stop();
    expect(await run.done).toBe(0);
    expect(run.autoStart).not.toHaveBeenCalled();
    expect(run.out()).toBe("14:02:11 web error boom\nwarn line\n");
    expect(run.err()).toBe("sentra: failed envelope: bad gzip\n");
    expect(run.subs[0]?.closed).toBe(true);
  });

  it("applies --service, --kind, --level and --q on the client", async () => {
    const run = start({ service: ["api"], kind: "log", level: ["info"], query: "DISK" });
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    const { onEvent } = run.subs[0]?.handlers ?? fakeHandlers();
    onEvent(item({ service: "api", kind: "log", level: "info", title: "disk full" }, "match"));
    onEvent(item({ service: "web", kind: "log", level: "info", title: "disk full" }, "svc"));
    onEvent(item({ service: "api", kind: "log", level: "error", title: "disk full" }, "lvl"));
    onEvent(item({ service: "api", kind: "log", level: "info", title: "cpu" }, "q"));
    onEvent(item({ service: "api", kind: "error", level: "info", title: "disk" }, "kind"));
    run.stop();
    await run.done;
    expect(run.out()).toBe("match\n");
  });

  it("rejects kinds the daemon does not stream", async () => {
    const t = setup();
    expect(await runSentraCli(["live", "--kind", "transaction"], t.deps)).toBe(2);
    expect(t.err()).toContain('Invalid --kind "transaction". Use one of: error, message, log.');
  });

  it("keeps the kind default with only --min-level", async () => {
    const run = start({ minLevel: "error" });
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    const { onEvent } = run.subs[0]?.handlers ?? fakeHandlers();
    onEvent(item({ kind: "error", level: "error" }, "error"));
    onEvent(item({ kind: "message", level: "fatal" }, "fatal message"));
    onEvent(item({ kind: "message", level: "warning" }, "warning"));
    onEvent(item({ kind: "log", level: "error" }, "log"));
    run.stop();
    await run.done;
    expect(run.out()).toBe("error\nfatal message\n");
  });

  it("writes rows as NDJSON with --json", async () => {
    const run = start({ json: true });
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    run.subs[0]?.handlers.onEvent(item({}));
    run.subs[0]?.handlers.onEvent(item({ id: "second" }));
    run.stop();
    await run.done;
    expect(run.out()).toBe(`${JSON.stringify(ROW)}\n${JSON.stringify({ ...ROW, id: "second" })}\n`);
  });

  it("reconnects every 2 s, re-resolves the session and warns once per outage", async () => {
    const run = start();
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    run.subs[0]?.handlers.onSubscribed();
    run.subs[0]?.handlers.onEnd();
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(1));
    expect(run.live.sleep).toHaveBeenCalledWith(2000);
    expect(run.err()).toBe("sentra: waiting for daemon…\n");

    vi.mocked(run.live.request).mockResolvedValueOnce({ id: "1", error: "boom" });
    run.sleeps[0]?.();
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(2));
    expect(run.subs).toHaveLength(1);

    const moved = { ...RUNNING, id: "dddddddddddd" };
    vi.mocked(run.live.request).mockResolvedValue({ id: "1", result: [moved] });
    run.sleeps[1]?.();
    await vi.waitFor(() => expect(run.subs).toHaveLength(2));
    expect(run.subs[1]?.sessionId).toBe(moved.id);
    run.subs[1]?.handlers.onEnd();
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(3));
    expect(run.err()).toBe("sentra: waiting for daemon…\n");

    run.sleeps[2]?.();
    await vi.waitFor(() => expect(run.subs).toHaveLength(3));
    run.subs[2]?.handlers.onSubscribed();
    run.subs[2]?.handlers.onEnd();
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(4));
    expect(run.err()).toBe("sentra: waiting for daemon…\nsentra: waiting for daemon…\n");

    run.stop();
    expect(await run.done).toBe(0);
  });

  it("ignores a second end and late callbacks of a finished subscription", async () => {
    const run = start();
    await vi.waitFor(() => expect(run.subs).toHaveLength(1));
    run.subs[0]?.handlers.onEnd();
    run.subs[0]?.handlers.onEnd();
    run.subs[0]?.handlers.onSubscribed();
    run.subs[0]?.handlers.onEvent(item({}));
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(1));
    expect(run.out()).toBe("");
    run.sleeps[0]?.();
    await vi.waitFor(() => expect(run.subs).toHaveLength(2));
    run.subs[1]?.handlers.onEnd();
    await vi.waitFor(() => expect(run.sleeps).toHaveLength(2));
    expect(run.err()).toBe("sentra: waiting for daemon…\n");
    run.stop();
    expect(await run.done).toBe(0);
  });

  it("exits 1 when disabled, unavailable or not running", async () => {
    const disabled = start({}, { ...STATUS, enabled: false, state: "disabled" });
    expect(await disabled.done).toBe(1);
    expect(disabled.err()).toContain("Sentra is not enabled for this project");

    const unavailable = start({}, { ...STATUS, state: "unavailable", reason: "port bind failed" });
    expect(await unavailable.done).toBe(1);
    expect(unavailable.err()).toBe("Error: Sentra is unavailable: port bind failed\n");

    const stopped = start({}, { ...STATUS, enabled: null });
    expect(await stopped.done).toBe(1);
    expect(stopped.err()).toBe("Error: No running zaps session for this project.\n");
    expect(stopped.subs).toHaveLength(0);
  });

  it("exits 1 on status errors and without streaming support", async () => {
    const old = liveSetup({});
    expect(await runSentraCommand("live", {}, old.deps)).toBe(1);
    expect(old.err()).toContain("older than the CLI");

    const none = setup({ "sentra.status": ok(STATUS) });
    expect(await runSentraCommand("live", {}, none.deps)).toBe(1);
    expect(none.err()).toBe("Error: live streaming is not available here.\n");
  });

  it("parses live flags through the sentra CLI", async () => {
    const ctx = liveSetup({ "sentra.status": ok(STATUS) });
    const done = runSentraCli(["live", "--service", "web", "--q", "BOOM", "--json"], ctx.deps);
    await vi.waitFor(() => expect(ctx.subs).toHaveLength(1));
    ctx.subs[0]?.handlers.onEvent(item({ title: "boom here" }));
    ctx.subs[0]?.handlers.onEvent(item({ title: "other" }));
    ctx.stop();
    expect(await done).toBe(0);
    expect(ctx.out()).toBe(`${JSON.stringify({ ...ROW, title: "boom here" })}\n`);
  });

  it("exits 1 without starting a daemon that is not running", async () => {
    const ctx = liveSetup({});
    vi.mocked(ctx.live.request).mockRejectedValue(new CliError("Daemon not running."));
    expect(await runSentraCommand("live", {}, ctx.deps)).toBe(1);
    expect(ctx.err()).toBe("Error: Daemon not running.\n");
    expect(ctx.autoStart).not.toHaveBeenCalled();
  });

  it("rejects invalid filters with exit 2", async () => {
    const run = start({ kind: "nope" });
    expect(await run.done).toBe(2);
    expect(run.subs).toHaveLength(0);
  });
});

describe("withLiveDefaults / matchesLive", () => {
  it("defaults only without kind/level flags", () => {
    expect(withLiveDefaults({})).toEqual({ kind: ["error", "message"], minLevel: "warning" });
    expect(withLiveDefaults({ minLevel: "error" })).toEqual({
      kind: ["error", "message"],
      minLevel: "error",
    });
    expect(withLiveDefaults({ level: ["info"] })).toEqual({
      kind: ["error", "message"],
      level: ["info"],
      minLevel: undefined,
    });
    expect(withLiveDefaults({ kind: ["log"] })).toEqual({ kind: ["log"], minLevel: undefined });
  });

  it("maps service filters to the sanitized DSN segment", () => {
    expect(withLiveDefaults({ service: ["web app"] }).service).toEqual(["web-app"]);
  });

  it("drops level-less rows under a level filter", () => {
    expect(matchesLive({ ...ROW, level: null }, { minLevel: "debug" })).toBe(false);
    expect(matchesLive({ ...ROW, level: null }, { level: ["error"] })).toBe(false);
    expect(matchesLive({ ...ROW, level: null }, {})).toBe(true);
  });
});
