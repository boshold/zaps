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
    DaemonServer: vi.fn(() => {
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

const { ensureDaemon } = await import("../../src/daemon/index.js");

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
