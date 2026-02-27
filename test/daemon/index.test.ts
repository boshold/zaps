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
  },
}));

vi.mock("node:os", () => ({
  default: {
    tmpdir: () => "/tmp",
    userInfo: () => ({ uid: 1000 }),
  },
}));

vi.mock("node:net", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  return {
    default: {
      createConnection: vi.fn(() => {
        const socket = new EE();
        (socket as unknown as Record<string, unknown>)["write"] = vi.fn();
        (socket as unknown as Record<string, unknown>)["destroy"] = vi.fn();
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
        (server as unknown as Record<string, unknown>)["listen"] = vi.fn(
          // eslint-disable-next-line prefer-await-to-callbacks -- vi.mock callback pattern
          (_path: string, cb: () => void) => {
            setTimeout(cb, 0);
          },
        );
        (server as unknown as Record<string, unknown>)["close"] = vi.fn();
        return server;
      }),
    },
  };
});

vi.mock("../../src/daemon/server.js", () => {
  // eslint-disable-next-line no-require-imports, global-require, no-var-requires -- vi.mock factory requires synchronous require
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");
  return {
    // Must use `function` (not arrow) so `new DaemonServer()` works in runDaemon
    DaemonServer: vi.fn(function () {
      const emitter = new EE();
      return Object.assign(emitter, {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        sessionCount: 0,
        onSessionChange: undefined,
      });
    }),
  };
});

const { ensureDaemon, runDaemon } = await import("../../src/daemon/index.js");
const { DaemonServer } = await import("../../src/daemon/server.js");

describe("ensureDaemon", () => {
  const originalKill = process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    process.kill = vi.fn() as unknown as typeof process.kill;
    delete process.env["XDG_RUNTIME_DIR"];
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

    const sock = await ensureDaemon("zaps");
    expect(sock).toMatch(/daemon\.sock$/);
  });

  it("spawns new daemon when not running", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    // First readPid returns null (no daemon)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const sock = await ensureDaemon("zaps");
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

    const sock = await ensureDaemon("zaps");
    expect(sock).toMatch(/daemon\.sock$/);
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
    processOnSpy = vi.spyOn(process, "on");
    delete process.env["XDG_RUNTIME_DIR"];

    // Re-establish DaemonServer mock (vi.restoreAllMocks in other suites may clear it)
    const { EventEmitter } = await import("node:events");
    vi.mocked(DaemonServer).mockImplementation(function () {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        sessionCount: 0,
        onSessionChange: undefined,
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
    const call = processOnSpy.mock.calls.find(
      ([ev]: [string]) => ev === signal,
    );
    return call[1] as () => void;
  }

  function serverInstance() {
    return vi.mocked(DaemonServer).mock.results[0]!.value as {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      sessionCount: number;
      onSessionChange?: (count: number) => void;
    };
  }

  it("writes PID and starts server on socket path", async () => {
    await runDaemon();

    const fs = (await import("node:fs")).default;
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.openSync).toHaveBeenCalled();
    expect(serverInstance().start).toHaveBeenCalledWith(
      expect.stringMatching(/daemon\.sock$/),
    );
  });

  it("shuts down on idle timeout with no sessions", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // starts idle timer
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("resets idle when sessions still active at timeout", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // starts idle timer
    server.sessionCount = 1; // sessions active before timeout fires
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(0);
  });

  it("cancels idle timer when sessions become active", async () => {
    await runDaemon();
    const server = serverInstance();

    server.onSessionChange!(0); // starts idle timer
    server.onSessionChange!(1); // cancel idle
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.stop).not.toHaveBeenCalled();
  });

  it("shuts down on SIGTERM", async () => {
    await runDaemon();
    signalHandler("SIGTERM")();

    expect(serverInstance().stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("shuts down on SIGINT", async () => {
    await runDaemon();
    signalHandler("SIGINT")();

    expect(serverInstance().stop).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("logs messages and closes log file on shutdown", async () => {
    await runDaemon();
    const fs = (await import("node:fs")).default;

    signalHandler("SIGTERM")();

    expect(fs.writeSync).toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalled();
  });
});

describe("pingSocket branches", () => {
  const originalKill = process.kill;

  beforeEach(() => {
    vi.clearAllMocks();
    process.kill = vi.fn() as unknown as typeof process.kill;
    delete process.env["XDG_RUNTIME_DIR"];
  });

  afterEach(() => {
    process.kill = originalKill;
    vi.restoreAllMocks();
  });

  it("resolves false on socket error and relaunches daemon", async () => {
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    vi.mocked(
      process.kill as unknown as ReturnType<typeof vi.fn>,
    ).mockReturnValue(undefined);

    const netModule = await import("node:net");
    const { EventEmitter } = await import("node:events");

    let callCount = 0;
    vi.mocked(netModule.default.createConnection).mockImplementation(
      (() => {
        callCount++;
        const socket = new EventEmitter();
        Object.assign(socket, { write: vi.fn(), destroy: vi.fn() });
        if (callCount === 1) {
          // First call: error (stale socket)
          setTimeout(
            () => socket.emit("error", new Error("ECONNREFUSED")),
            5,
          );
        } else {
          // Subsequent: success
          setTimeout(() => {
            socket.emit("connect");
            setTimeout(
              () => socket.emit("data", Buffer.from("pong")),
              5,
            );
          }, 5);
        }
        return socket as unknown as ReturnType<
          typeof netModule.default.createConnection
        >;
      }) as typeof netModule.default.createConnection,
    );

    const sock = await ensureDaemon("zaps");
    expect(sock).toMatch(/daemon\.sock$/);

    const { spawn } = await import("node:child_process");
    expect(spawn).toHaveBeenCalled();
  });

  it("resolves false on socket timeout and relaunches daemon", async () => {
    vi.useFakeTimers();

    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    vi.mocked(
      process.kill as unknown as ReturnType<typeof vi.fn>,
    ).mockReturnValue(undefined);

    const netModule = await import("node:net");
    const { EventEmitter } = await import("node:events");

    let callCount = 0;
    vi.mocked(netModule.default.createConnection).mockImplementation(
      (() => {
        callCount++;
        const socket = new EventEmitter();
        Object.assign(socket, { write: vi.fn(), destroy: vi.fn() });
        if (callCount > 1) {
          // Success for subsequent pings via microtask (unaffected by fake timers)
          queueMicrotask(() => {
            socket.emit("connect");
            queueMicrotask(() =>
              socket.emit("data", Buffer.from("pong")),
            );
          });
        }
        // First call: no events → relies on 500ms timeout in pingSocket
        return socket as unknown as ReturnType<
          typeof netModule.default.createConnection
        >;
      }) as typeof netModule.default.createConnection,
    );

    const promise = ensureDaemon("zaps");
    // Advance past pingSocket's 500ms timeout
    await vi.advanceTimersByTimeAsync(500);
    // Advance past poll delay + let microtask-based success resolve
    await vi.advanceTimersByTimeAsync(100);

    const sock = await promise;
    expect(sock).toMatch(/daemon\.sock$/);

    vi.useRealTimers();
  });
});
