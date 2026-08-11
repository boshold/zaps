import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
    pid: 9999,
  })),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => "12345"),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    existsSync: vi.fn(() => true),
  },
}));

vi.mock("node:os", () => ({
  default: {
    tmpdir: () => "/tmp",
    userInfo: () => ({ uid: 1000 }),
    homedir: () => "/home/test",
  },
}));

vi.mock("node:net", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  return {
    default: {
      createConnection: vi.fn(() => {
        const socket = new EE();
        (socket as unknown as Record<string, unknown>).write = vi.fn();
        (socket as unknown as Record<string, unknown>).destroy = vi.fn();
        // Auto-connect and respond with pong
        setTimeout(() => {
          socket.emit("connect");
          setTimeout(() => {
            socket.emit("data", Buffer.from('{"id":"ping0","result":"pong"}\n'));
          }, 5);
        }, 5);
        return socket;
      }),
      createServer: vi.fn(() => {
        const server = new EE();
        (server as unknown as Record<string, unknown>).listen = vi.fn(
          // eslint-disable-next-line prefer-await-to-callbacks -- vi.mock callback pattern
          (_path: string, cb: () => void) => {
            setTimeout(cb, 0);
          },
        );
        (server as unknown as Record<string, unknown>).close = vi.fn();
        return server;
      }),
    },
  };
});

vi.mock("../../src/daemon/server.js", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  return {
    // Must be constructible (not arrow) so `new DaemonServer()` works in runDaemon
    // eslint-disable-next-line prefer-arrow-callback -- arrow functions cannot be constructed
    DaemonServer: vi.fn(function mockDaemonServer() {
      const emitter = new EE();
      return Object.assign(emitter, {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        list: vi.fn(() => []),
        destroy: vi.fn().mockResolvedValue(undefined),
        reapDetachedOrphans: vi.fn(),
        sessionCount: 0,
        onSessionChange: undefined,
        requestShutdown: undefined,
      });
    }),
  };
});

const { createShutdownAll, ensureDaemon, runDaemon } = await import("../../src/daemon/index.js");
const { DaemonServer } = await import("../../src/daemon/server.js");
const { runShutdownHook } = await import("../../src/daemon/shutdown.js");

describe("ensureDaemon", () => {
  const originalKill = process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    process.kill = vi.fn() as unknown as typeof process.kill;
    delete process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    process.kill = originalKill;
    vi.restoreAllMocks();
  });

  it("returns socket path when daemon already alive and responsive", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    vi.mocked(process.kill as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const sock = await ensureDaemon({ file: "zaps", args: [] });
    expect(sock).toMatch(/daemon\.sock$/);
  });

  it("spawns new daemon when not running", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    // First readPid returns null (no daemon)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const sock = await ensureDaemon({ file: "zaps", args: [] });
    expect(sock).toMatch(/daemon\.sock$/);

    const { spawn } = await import("node:child_process");
    expect(spawn).toHaveBeenCalledWith("zaps", ["daemon", "run"], expect.any(Object));
  });

  it("cleans stale PID and relaunches", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("99999");
    // Kill(pid, 0) throws — process not found
    vi.mocked(process.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const sock = await ensureDaemon({ file: "zaps", args: [] });
    expect(sock).toMatch(/daemon\.sock$/);
  });

  it("does not fork a second daemon when the spawn lock is held (D4)", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    // ReadPid (daemon.pid) → garbage → isDaemonRunning false without calling kill;
    // Then the spawn.lock read returns a live holder pid → lock is not stale.
    vi.mocked(fs.readFileSync).mockReturnValueOnce("garbage").mockReturnValueOnce("12345");
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    });
    vi.mocked(process.kill as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const sock = await ensureDaemon({ file: "zaps", args: [] });
    expect(sock).toMatch(/daemon\.sock$/);

    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns with split argv and forwards ZAPS_COMMAND for source runs (E1/E2)", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await ensureDaemon({ file: "node", args: ["/path/cli.mjs"] });

    const { spawn } = await import("node:child_process");
    const call = vi.mocked(spawn).mock.calls.at(-1);
    expect(call?.[0]).toBe("node");
    expect(call?.[1]).toEqual(["/path/cli.mjs", "daemon", "run"]);
    const opts = call?.[2] as { env: Record<string, string> };
    expect(opts.env.ZAPS_COMMAND).toBe("node /path/cli.mjs");
  });

  it("strips ZAPS_TMUX_SOCKET + TMUX from the daemon child env (sanitization rule)", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.ZAPS_TMUX_SOCKET = "zaps";
    process.env.TMUX = "/tmp/tmux-1000/zaps,123,0";

    try {
      await ensureDaemon({ file: "zaps", args: [] });
    } finally {
      delete process.env.ZAPS_TMUX_SOCKET;
      delete process.env.TMUX;
    }

    const { spawn } = await import("node:child_process");
    const call = vi.mocked(spawn).mock.calls.at(-1);
    const opts = call?.[2] as { env: Record<string, string | undefined> };
    expect(opts.env.ZAPS_TMUX_SOCKET).toBeUndefined();
    expect(opts.env.TMUX).toBeUndefined();
    expect(opts.env.ZAPS_COMMAND).toBe("zaps");
  });

  it("spawns the daemon in a stable cwd so a deleted project dir can't poison it", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await ensureDaemon({ file: "zaps", args: [] });

    const { spawn } = await import("node:child_process");
    const opts = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { cwd?: string };
    expect(opts.cwd).toBe("/home/test");
  });

  it("throws a clear error when the daemon spawn fails (E1)", async () => {
    vi.useFakeTimers();
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const netModule = await import("node:net");
    const { EventEmitter } = await import("node:events");
    // Socket never connects → pingSocket relies on its 500ms timeout → false.
    vi.mocked(netModule.default.createConnection).mockImplementation((() => {
      const socket = new EventEmitter();
      Object.assign(socket, { write: vi.fn(), destroy: vi.fn() });
      return socket as unknown as ReturnType<typeof netModule.default.createConnection>;
    }) as typeof netModule.default.createConnection);

    const { spawn } = await import("node:child_process");
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: undefined });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const promise = ensureDaemon({ file: "nonexistent", args: [] });
    // The listener is registered synchronously; emit the spawn failure now.
    child.emit("error", new Error("spawn nonexistent ENOENT"));

    // Attach the rejection assertion before advancing timers so the pending
    // Rejection is never momentarily unhandled.
    const rejection = expect(promise).rejects.toThrow(
      /Failed to start daemon \('nonexistent'\): spawn nonexistent ENOENT/,
    );
    await vi.advanceTimersByTimeAsync(600);
    await rejection;

    vi.useRealTimers();
  });
});

describe("runDaemon", () => {
  const originalExit = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy type is complex
  let processOnSpy: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.exit = vi.fn() as unknown as typeof process.exit;
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    delete process.env.XDG_RUNTIME_DIR;

    // Re-establish DaemonServer mock (vi.restoreAllMocks in other suites may clear it)
    const { EventEmitter } = await import("node:events");
    // eslint-disable-next-line prefer-arrow-callback -- arrow functions cannot be constructed
    vi.mocked(DaemonServer).mockImplementation(function mockDaemonServer() {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        list: vi.fn(() => []),
        destroy: vi.fn().mockResolvedValue(undefined),
        reapDetachedOrphans: vi.fn(),
        sessionCount: 0,
        onSessionChange: undefined,
        requestShutdown: undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock instance
      }) as any;
    });
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function signalHandler(signal: string): () => void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mock type
    const call = processOnSpy.mock.calls.find(([ev]: [string]) => ev === signal);
    return call[1] as () => void;
  }

  function serverInstance() {
    return vi.mocked(DaemonServer).mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      sessionCount: number;
      onSessionChange?: (count: number) => void;
      requestShutdown?: () => void;
    };
  }

  it("writes PID and starts server on socket path", async () => {
    await runDaemon();

    const { default: fs } = await import("node:fs");
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.openSync).toHaveBeenCalled();
    expect(serverInstance().start).toHaveBeenCalledWith(expect.stringMatching(/daemon\.sock$/));
  });

  it("deletes inherited tmux env at startup (socket selection is per-session)", async () => {
    process.env.ZAPS_TMUX_SOCKET = "zaps";
    process.env.TMUX = "/tmp/tmux-1000/zaps,123,0";

    await runDaemon();

    expect(process.env.ZAPS_TMUX_SOCKET).toBeUndefined();
    expect(process.env.TMUX).toBeUndefined();
  });

  it("shuts down on idle timeout with no sessions", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // Starts idle timer
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("resets idle when sessions still active at timeout", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // Starts idle timer
    server.sessionCount = 1; // Sessions active before timeout fires
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(0);
  });

  it("cancels idle timer when sessions become active", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // Starts idle timer
    server.onSessionChange!(1); // Cancel idle
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).not.toHaveBeenCalled();
  });

  it("arms the idle timer at startup with no session ever created (D5)", async () => {
    await runDaemon();
    const server = serverInstance();

    // No onSessionChange(0) call — the idle timer must already be armed by the
    // Startup `idle.reset()`, so a daemon that never gets a session still exits.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("wires daemon.shutdown IPC to the same shutdownAll path (D1)", async () => {
    await runDaemon();
    const server = serverInstance();

    // The IPC handler invokes the registered module hook (not a server method —
    // A dynamically-assigned property was unreliable in the bun native binary).
    await runShutdownHook();
    await vi.advanceTimersByTimeAsync(0);

    expect(server.stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("is re-entry safe: a signal during IPC shutdown does not double-destroy (D1)", async () => {
    await runDaemon();
    const server = serverInstance();

    await runShutdownHook(); // IPC-triggered shutdown
    signalHandler("SIGTERM")(); // Signal arrives during teardown
    await vi.advanceTimersByTimeAsync(0);

    // Re-entry guard: the server is stopped and the process exits exactly once.
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  it("shuts down on SIGTERM", async () => {
    await runDaemon();
    signalHandler("SIGTERM")();
    // Teardown then exit are chained off the async shutdownAll promise.
    await vi.advanceTimersByTimeAsync(0);

    expect(serverInstance().stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("shuts down on SIGINT", async () => {
    await runDaemon();
    signalHandler("SIGINT")();
    await vi.advanceTimersByTimeAsync(0);

    expect(serverInstance().stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("logs messages and closes log file on shutdown", async () => {
    await runDaemon();
    const { default: fs } = await import("node:fs");

    signalHandler("SIGTERM")();
    await vi.advanceTimersByTimeAsync(0);

    expect(fs.writeSync).toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalled();
  });

  it("removes runtime files on shutdown when it owns the pid file (D4)", async () => {
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(String(process.pid));

    await runDaemon();
    vi.mocked(fs.unlinkSync).mockClear();
    signalHandler("SIGTERM")();

    // Both daemon.sock and daemon.pid are unlinked.
    const targets = vi.mocked(fs.unlinkSync).mock.calls.map(([p]) => String(p));
    expect(targets.some((p) => p.includes("daemon.sock"))).toBe(true);
    expect(targets.some((p) => p.includes("daemon.pid"))).toBe(true);
  });

  it("does not remove runtime files on shutdown when the pid file was taken over (D4)", async () => {
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(String(process.pid + 1));

    await runDaemon();
    vi.mocked(fs.unlinkSync).mockClear();
    signalHandler("SIGTERM")();

    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  function listener(event: string): (arg: unknown) => void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mock type
    const call = processOnSpy.mock.calls.find(([ev]: [string]) => ev === event);
    return call[1] as (arg: unknown) => void;
  }

  it("logs unhandledRejection with stack and stays alive", async () => {
    await runDaemon();
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.writeSync).mockClear();

    listener("unhandledRejection")(new Error("boom"));

    const written = vi
      .mocked(fs.writeSync)
      .mock.calls.map(([, msg]) => msg)
      .join("");
    expect(written).toContain("unhandledRejection");
    expect(written).toContain("boom");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("logs non-Error unhandledRejection reason via String()", async () => {
    await runDaemon();
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.writeSync).mockClear();

    listener("unhandledRejection")("plain reason");

    const written = vi
      .mocked(fs.writeSync)
      .mock.calls.map(([, msg]) => msg)
      .join("");
    expect(written).toContain("unhandledRejection: plain reason");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("logs uncaughtException and stays alive", async () => {
    await runDaemon();
    const { default: fs } = await import("node:fs");
    vi.mocked(fs.writeSync).mockClear();

    listener("uncaughtException")(new Error("kaboom"));

    const written = vi
      .mocked(fs.writeSync)
      .mock.calls.map(([, msg]) => msg)
      .join("");
    expect(written).toContain("uncaughtException");
    expect(written).toContain("kaboom");
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe("createShutdownAll", () => {
  it("destroys every session, then stops the server and finalizes", async () => {
    const destroyed: string[] = [];
    const order: string[] = [];
    const server = {
      list: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
      destroy: async (id: string) => {
        destroyed.push(id);
      },
      stop: () => order.push("stop"),
    };
    const finalize = () => order.push("finalize");
    const shutdownAll = createShutdownAll(server, vi.fn(), finalize);

    await shutdownAll();

    expect(destroyed).toEqual(["a", "b", "c"]);
    // Server is stopped and finalize runs only after all sessions are destroyed.
    expect(order).toEqual(["stop", "finalize"]);
  });

  it("isolates a failing session destroy: others, stop and finalize still run", async () => {
    const destroyed: string[] = [];
    const logs: string[] = [];
    let stopped = false;
    let finalized = false;
    const server = {
      list: () => [{ id: "a" }, { id: "bad" }, { id: "c" }],
      destroy: async (id: string) => {
        if (id === "bad") {
          throw new Error("destroy boom");
        }
        destroyed.push(id);
      },
      stop: () => {
        stopped = true;
      },
    };
    const shutdownAll = createShutdownAll(
      server,
      (m) => logs.push(m),
      () => {
        finalized = true;
      },
    );

    await shutdownAll();

    expect(destroyed).toEqual(["a", "c"]);
    expect(
      logs.some((m) => m.includes("error destroying session bad") && m.includes("destroy boom")),
    ).toBe(true);
    expect(stopped).toBe(true);
    expect(finalized).toBe(true);
  });

  it("is idempotent: a second call is a no-op (re-entry safe)", async () => {
    let destroyCalls = 0;
    let stopCalls = 0;
    let finalizeCalls = 0;
    const server = {
      list: () => [{ id: "a" }],
      destroy: async () => {
        destroyCalls += 1;
      },
      stop: () => {
        stopCalls += 1;
      },
    };
    const shutdownAll = createShutdownAll(server, vi.fn(), () => {
      finalizeCalls += 1;
    });

    await shutdownAll();
    await shutdownAll();

    expect(destroyCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(finalizeCalls).toBe(1);
  });
});

describe("pingSocket branches", () => {
  const originalKill = process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    process.kill = vi.fn() as unknown as typeof process.kill;
    delete process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    process.kill = originalKill;
    vi.restoreAllMocks();
  });

  it("resolves false on socket error and relaunches daemon", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    vi.mocked(process.kill as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const netModule = await import("node:net");
    const { EventEmitter } = await import("node:events");

    let callCount = 0;
    vi.mocked(netModule.default.createConnection).mockImplementation((() => {
      callCount += 1;
      const socket = new EventEmitter();
      Object.assign(socket, { write: vi.fn(), destroy: vi.fn() });
      if (callCount === 1) {
        // First call: error (stale socket)
        setTimeout(() => socket.emit("error", new Error("ECONNREFUSED")), 5);
      } else {
        // Subsequent: success
        setTimeout(() => {
          socket.emit("connect");
          setTimeout(() => socket.emit("data", Buffer.from("pong")), 5);
        }, 5);
      }
      return socket as unknown as ReturnType<typeof netModule.default.createConnection>;
    }) as typeof netModule.default.createConnection);

    const sock = await ensureDaemon({ file: "zaps", args: [] });
    expect(sock).toMatch(/daemon\.sock$/);

    const { spawn } = await import("node:child_process");
    expect(spawn).toHaveBeenCalled();
  });

  it("resolves false on socket timeout and relaunches daemon", async () => {
    vi.useFakeTimers();

    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    vi.mocked(process.kill as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const netModule = await import("node:net");
    const { EventEmitter } = await import("node:events");

    let callCount = 0;
    vi.mocked(netModule.default.createConnection).mockImplementation((() => {
      callCount += 1;
      const socket = new EventEmitter();
      Object.assign(socket, { write: vi.fn(), destroy: vi.fn() });
      if (callCount > 1) {
        // Success for subsequent pings via microtask (unaffected by fake timers)
        queueMicrotask(() => {
          socket.emit("connect");
          queueMicrotask(() => socket.emit("data", Buffer.from("pong")));
        });
      }
      // First call: no events → relies on 500ms timeout in pingSocket
      return socket as unknown as ReturnType<typeof netModule.default.createConnection>;
    }) as typeof netModule.default.createConnection);

    const promise = ensureDaemon({ file: "zaps", args: [] });
    // Advance past pingSocket's 500ms timeout
    await vi.advanceTimersByTimeAsync(500);
    // Advance past poll delay + let microtask-based success resolve
    await vi.advanceTimersByTimeAsync(100);

    const sock = await promise;
    expect(sock).toMatch(/daemon\.sock$/);

    vi.useRealTimers();
  });
});
