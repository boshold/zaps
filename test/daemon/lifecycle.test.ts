import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  },
}));

vi.mock("node:os", () => ({
  default: {
    tmpdir: () => "/tmp",
    userInfo: () => ({ uid: 1000 }),
  },
}));

const fsModule = await import("node:fs");
const fs = fsModule.default;
const mockKill = vi.fn();
const originalKill = process.kill;

beforeEach(() => {
  vi.clearAllMocks();
  process.kill = mockKill as unknown as typeof process.kill;
  delete process.env.XDG_RUNTIME_DIR;
});

afterEach(() => {
  process.kill = originalKill;
});

const {
  daemonDir,
  socketPath,
  pidPath,
  logPath,
  writePid,
  readPid,
  removePid,
  removeSocket,
  isDaemonRunning,
  IdleTimer,
  spawnLockPath,
  acquireSpawnLock,
  releaseSpawnLock,
  ownsPidFile,
} = await import("../../src/daemon/lifecycle.js");

function eexist(): NodeJS.ErrnoException {
  return Object.assign(new Error("EEXIST"), { code: "EEXIST" });
}

describe("path helpers", () => {
  it("daemonDir uses XDG_RUNTIME_DIR when set", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const dir = daemonDir();
    expect(dir).toBe("/run/user/1000/zaps");
    expect(fs.mkdirSync).toHaveBeenCalledWith("/run/user/1000/zaps", { recursive: true });
  });

  it("daemonDir falls back to tmpdir", () => {
    const dir = daemonDir();
    expect(dir).toBe("/tmp/zaps-1000");
  });

  it("socketPath returns path under daemonDir", () => {
    const sock = socketPath();
    expect(sock).toMatch(/daemon\.sock$/);
  });

  it("pidPath returns path under daemonDir", () => {
    const pid = pidPath();
    expect(pid).toMatch(/daemon\.pid$/);
  });

  it("logPath returns path under daemonDir", () => {
    const log = logPath();
    expect(log).toMatch(/daemon\.log$/);
  });
});

describe("PID operations", () => {
  it("writePid writes current process PID", () => {
    writePid();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("daemon.pid"),
      String(process.pid),
      "utf8",
    );
  });

  it("readPid returns parsed PID", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    expect(readPid()).toBe(12_345);
  });

  it("readPid returns null for NaN", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("not-a-number");
    expect(readPid()).toBeNull();
  });

  it("readPid returns null when file missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readPid()).toBeNull();
  });

  it("removePid calls unlinkSync", () => {
    removePid();
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("daemon.pid"));
  });

  it("removePid swallows errors", () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => removePid()).not.toThrow();
  });

  it("removeSocket calls unlinkSync", () => {
    removeSocket();
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("daemon.sock"));
  });

  it("removeSocket swallows errors", () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => removeSocket()).not.toThrow();
  });
});

describe("isDaemonRunning", () => {
  it("returns false when no PID file", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isDaemonRunning()).toBe(false);
  });

  it("returns true when process is alive", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    mockKill.mockReturnValue(undefined);
    expect(isDaemonRunning()).toBe(true);
    expect(mockKill).toHaveBeenCalledWith(12_345, 0);
  });

  it("returns false and cleans up stale PID", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("99999");
    mockKill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(isDaemonRunning()).toBe(false);
    // Should have cleaned up PID and socket
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});

describe("spawn lock", () => {
  it("spawnLockPath is under daemonDir", () => {
    expect(spawnLockPath()).toMatch(/spawn\.lock$/);
  });

  it("acquires when the lock file does not exist", () => {
    vi.mocked(fs.openSync).mockReset();
    vi.mocked(fs.openSync).mockReturnValue(3);
    expect(acquireSpawnLock()).toBe(true);
    expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining("spawn.lock"), "wx");
  });

  it("fails to acquire when a live lock is held", () => {
    vi.mocked(fs.openSync).mockReset();
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw eexist();
    });
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as ReturnType<
      typeof fs.statSync
    >);
    vi.mocked(fs.readFileSync).mockReturnValue("12345");
    mockKill.mockReturnValue(undefined); // Holder alive

    expect(acquireSpawnLock()).toBe(false);
  });

  it("breaks and re-acquires a stale lock (dead holder pid)", () => {
    vi.mocked(fs.openSync).mockReset();
    vi.mocked(fs.openSync)
      .mockImplementationOnce(() => {
        throw eexist();
      })
      .mockReturnValue(3);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() } as ReturnType<
      typeof fs.statSync
    >);
    vi.mocked(fs.readFileSync).mockReturnValue("99999");
    mockKill.mockImplementation(() => {
      throw new Error("ESRCH"); // Holder dead
    });

    expect(acquireSpawnLock()).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("spawn.lock"));
  });

  it("breaks and re-acquires a stale lock (old mtime)", () => {
    vi.mocked(fs.openSync).mockReset();
    vi.mocked(fs.openSync)
      .mockImplementationOnce(() => {
        throw eexist();
      })
      .mockReturnValue(3);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now() - 20_000,
    } as ReturnType<typeof fs.statSync>);

    expect(acquireSpawnLock()).toBe(true);
  });

  it("releaseSpawnLock unlinks the lock file and swallows errors", () => {
    releaseSpawnLock();
    expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining("spawn.lock"));
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => releaseSpawnLock()).not.toThrow();
  });
});

describe("ownsPidFile", () => {
  it("returns true when the pid file names this process", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(String(process.pid));
    expect(ownsPidFile()).toBe(true);
  });

  it("returns false when the pid file names another process", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(String(process.pid + 1));
    expect(ownsPidFile()).toBe(false);
  });

  it("returns false when the pid file is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(ownsPidFile()).toBe(false);
  });
});

describe("IdleTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires callback after timeout", () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("reset delays the callback", () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();

    vi.advanceTimersByTime(500);
    timer.reset(); // Restart timer

    vi.advanceTimersByTime(500);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("cancel prevents callback", () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();

    vi.advanceTimersByTime(500);
    timer.cancel();

    vi.advanceTimersByTime(1000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("cancel is safe to call without reset", () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    expect(() => timer.cancel()).not.toThrow();
  });
});
