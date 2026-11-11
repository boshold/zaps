import { describe, expect, it, vi } from "vitest";

import { CliError } from "../../src/cli/helpers.js";
import type { SessionIpc } from "../../src/cli/helpers.js";
import { createServiceProgressPrinter, resolveStartFlag, runTask } from "../../src/cli/run-task.js";
import type { IpcResponse } from "../../src/lib/ipc/protocol.js";

type Frame = [event: string, data: unknown];

function fakeIpc(response: IpcResponse, frames: Frame[] = [], preflight?: IpcResponse) {
  const stream = vi.fn<SessionIpc["stream"]>(async (_method, _params, onEvent) => {
    for (const [event, data] of frames) {
      onEvent(event, data);
    }
    return response;
  });
  const request = vi.fn<SessionIpc["request"]>(async () => preflight ?? { id: "p", error: "x" });
  return { stream, request };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const data: unknown[] = [];
  return {
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      data: (d: unknown) => data.push(d),
    },
    out,
    err,
    data,
  };
}

describe("resolveStartFlag", () => {
  it.each([
    [{}, undefined],
    [{ start: true }, true],
    [{ noStart: true }, false],
    [{ start: false, noStart: false }, undefined],
  ])("%o → %s", (flags, expected) => {
    expect(resolveStartFlag(flags)).toBe(expected);
  });

  it("rejects --start with --no-start", () => {
    expect(() => resolveStartFlag({ start: true, noStart: true })).toThrow(CliError);
    expect(() => resolveStartFlag({ start: true, noStart: true })).toThrow(
      "--start and --no-start cannot be used together",
    );
  });
});

describe("createServiceProgressPrinter", () => {
  it("prints each phase once per service and ignores malformed data", () => {
    const lines: string[] = [];
    const print = createServiceProgressPrinter((t) => lines.push(t));
    print({ name: "db", phase: "starting" });
    print({ name: "db", phase: "starting" });
    print({ name: "api", phase: "waiting" });
    print({ name: "api", phase: "waiting" });
    print({ name: "db", phase: "ready" });
    print({ name: "api", phase: "ready" });
    print({ name: "x", phase: "bogus" });
    print("nope");
    expect(lines).toEqual(["Starting db…\n", "Waiting for api…\n", "db ready\n", "api ready\n"]);
  });
});

describe("runTask", () => {
  const ok: IpcResponse = { id: "r", result: { success: true, runId: "1", startedServices: [] } };

  it.each([
    [undefined, { key: "seed" }],
    [true, { key: "seed", start: true }],
    [false, { key: "seed", start: false }],
  ])("start=%s sends %o", async (start, params) => {
    const ipc = fakeIpc(ok);
    await runTask(ipc, { key: "seed", start, format: "text" }, capture().io);
    expect(ipc.stream).toHaveBeenCalledWith("tasks.run", params, expect.any(Function));
  });

  it("streams task output to stdout and service progress to stderr", async () => {
    const ipc = fakeIpc(ok, [
      ["service", { name: "db", phase: "starting" }],
      ["service", { name: "db", phase: "starting" }],
      ["service", { name: "db", phase: "ready" }],
      ["line", "hello"],
      ["progress", { key: "seed", result: "success" }],
    ]);
    const c = capture();
    await expect(runTask(ipc, { key: "seed", format: "text" }, c.io)).resolves.toBe(0);
    expect(c.out).toEqual(["hello\n"]);
    expect(c.err).toEqual(["Starting db…\n", "db ready\n"]);
  });

  it("returns 1 with Task failed. on failure", async () => {
    const c = capture();
    const code = await runTask(
      fakeIpc({ id: "r", result: { success: false, runId: "1", startedServices: [] } }),
      { key: "seed", format: "text" },
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err).toEqual(["Task failed.\n"]);
  });

  it("writes the result incl. startedServices for --json, keeping lines off stdout", async () => {
    const result = { success: true, runId: "1", startedServices: ["db"] };
    const c = capture();
    const code = await runTask(
      fakeIpc({ id: "r", result }, [
        ["line", "hello"],
        ["service", { name: "db", phase: "ready" }],
      ]),
      { key: "seed", format: "json" },
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out).toEqual([]);
    expect(c.data).toEqual([result]);
    expect(c.err).toEqual(["db ready\n"]);
  });

  it("appends the start hint for services_not_running using preflight names", async () => {
    const ipc = fakeIpc(
      {
        id: "r",
        error: 'Task "seed" needs services that are not running: db (stopped), api (error)',
        errorCode: "services_not_running",
      },
      [],
      {
        id: "p",
        result: {
          key: "seed",
          services: [
            { name: "cache", state: "ready", action: "ok", required: true, startable: false },
            { name: "db", state: "stopped", action: "start", required: true, startable: false },
            { name: "api", state: "error", action: "start", required: true, startable: false },
          ],
          needsStart: true,
          autoStart: false,
          blocked: [],
        },
      },
    );
    const c = capture();
    await expect(runTask(ipc, { key: "seed", format: "text" }, c.io)).resolves.toBe(1);
    expect(ipc.request).toHaveBeenCalledWith("tasks.preflight", { key: "seed" });
    expect(c.err).toEqual([
      'Error: Task "seed" needs services that are not running: db (stopped), api (error)\n',
      'Start them with "zaps start db api" or rerun with --start.\n',
    ]);
  });

  it("falls back to a generic hint when preflight fails", async () => {
    const ipc = fakeIpc({ id: "r", error: "m", errorCode: "services_not_running" });
    ipc.request.mockRejectedValue(new Error("gone"));
    const c = capture();
    await runTask(ipc, { key: "seed", format: "text" }, c.io);
    expect(c.err[1]).toBe('Start them with "zaps start <services>" or rerun with --start.\n');
  });

  it.each(["service_start_failed", "service_unavailable"] as const)(
    "prints %s errors without hint",
    async (errorCode) => {
      const ipc = fakeIpc({ id: "r", error: 'Service "db" failed to start: boom', errorCode });
      const c = capture();
      await expect(runTask(ipc, { key: "seed", format: "text" }, c.io)).resolves.toBe(1);
      expect(c.err).toEqual(['Error: Service "db" failed to start: boom\n']);
      expect(ipc.request).not.toHaveBeenCalled();
    },
  );
});
