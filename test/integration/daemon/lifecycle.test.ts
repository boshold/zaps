import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  IdleTimer,
  daemonDir,
  isDaemonRunning,
  logPath,
  pidPath,
  readPid,
  removePid,
  removeSocket,
  socketPath,
  writePid,
} from "#src/daemon/lifecycle.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon } from "../helpers/daemon.js";

/**
 * Minimal ping implementation matching daemon's pingSocket behavior.
 */
async function pingTestSocket(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(sock);
    client.on("connect", () => {
      const req = JSON.stringify({ id: "ping0", method: "daemon.ping" });
      client.write(`${req}\n`);
    });
    client.on("data", () => {
      client.destroy();
      resolve(true);
    });
    client.on("error", () => {
      resolve(false);
    });
    setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
  });
}

describe("lifecycle helpers", () => {
  let originalXdg: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalXdg = process.env["XDG_RUNTIME_DIR"];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-lifecycle-"));
    process.env["XDG_RUNTIME_DIR"] = tmpDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env["XDG_RUNTIME_DIR"];
    } else {
      process.env["XDG_RUNTIME_DIR"] = originalXdg;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Path helpers ───────────────────────────────────────────────────

  it("daemonDir() creates dir and returns path", () => {
    const dir = daemonDir();
    expect(dir).toBe(path.join(tmpDir, "zaps"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("socketPath() returns correct path under daemonDir", () => {
    const sock = socketPath();
    expect(sock).toBe(path.join(tmpDir, "zaps", "daemon.sock"));
  });

  it("pidPath() returns correct path under daemonDir", () => {
    const pid = pidPath();
    expect(pid).toBe(path.join(tmpDir, "zaps", "daemon.pid"));
  });

  it("logPath() returns correct path under daemonDir", () => {
    const log = logPath();
    expect(log).toBe(path.join(tmpDir, "zaps", "daemon.log"));
  });

  // ── PID management ─────────────────────────────────────────────────

  it("writePid() creates file containing process.pid", () => {
    daemonDir(); // Ensure dir
    writePid();
    const contents = fs.readFileSync(pidPath(), "utf8").trim();
    expect(Number.parseInt(contents, 10)).toBe(process.pid);
  });

  it("readPid() returns written PID", () => {
    daemonDir();
    writePid();
    expect(readPid()).toBe(process.pid);
  });

  it("readPid() returns null on missing file", () => {
    daemonDir();
    expect(readPid()).toBeNull();
  });

  it("removePid() removes the pid file", () => {
    daemonDir();
    writePid();
    expect(fs.existsSync(pidPath())).toBe(true);
    removePid();
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  it("removePid() is no-op if file missing", () => {
    daemonDir();
    expect(() => removePid()).not.toThrow();
  });

  // ── isDaemonRunning ────────────────────────────────────────────────

  it("isDaemonRunning() returns true for current PID", () => {
    daemonDir();
    writePid();
    expect(isDaemonRunning()).toBe(true);
  });

  it("isDaemonRunning() returns false for stale PID", () => {
    daemonDir();
    // Write a PID that definitely doesn't exist
    fs.writeFileSync(pidPath(), "999999999", "utf8");
    expect(isDaemonRunning()).toBe(false);
    // Should also clean up stale files
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  it("isDaemonRunning() returns false when no pid file", () => {
    daemonDir();
    expect(isDaemonRunning()).toBe(false);
  });

  // ── removeSocket ───────────────────────────────────────────────────

  it("removeSocket() removes socket file", () => {
    daemonDir();
    const sock = socketPath();
    fs.writeFileSync(sock, "");
    expect(fs.existsSync(sock)).toBe(true);
    removeSocket();
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("removeSocket() is no-op if file missing", () => {
    daemonDir();
    expect(() => removeSocket()).not.toThrow();
  });

  // ── IdleTimer ──────────────────────────────────────────────────────

  it("IdleTimer fires callback after timeout", async () => {
    const callback = vi.fn();
    const timer = new IdleTimer(100, callback);
    timer.reset();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(callback).toHaveBeenCalledOnce();
  });

  it("IdleTimer.reset() restarts countdown", async () => {
    const callback = vi.fn();
    const timer = new IdleTimer(150, callback);
    timer.reset();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callback).not.toHaveBeenCalled();

    timer.reset(); // Restart
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callback).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callback).toHaveBeenCalledOnce();
  });

  it("IdleTimer.cancel() prevents callback", async () => {
    const callback = vi.fn();
    const timer = new IdleTimer(100, callback);
    timer.reset();
    timer.cancel();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(callback).not.toHaveBeenCalled();
  });

  // ── pingSocket (via real DaemonServer) ─────────────────────────────

  describe("socket connectivity", () => {
    let testDaemon: TestDaemon;

    it("connecting to real DaemonServer succeeds", async () => {
      testDaemon = await createTestDaemon();
      const alive = await pingTestSocket(testDaemon.socketPath);
      expect(alive).toBe(true);
      await testDaemon.cleanup();
    });

    it("connecting to nonexistent socket fails", async () => {
      const fakeSock = path.join(tmpDir, "nonexistent.sock");
      const alive = await pingTestSocket(fakeSock);
      expect(alive).toBe(false);
    });
  });
});
