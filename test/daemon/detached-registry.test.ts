import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DetachedRegistry, defaultReadProcInfo } from "../../src/daemon/detached-registry.js";
import type { DetachedRegistryDeps } from "../../src/daemon/detached-registry.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const mockExecFileSync = vi.mocked(execFileSync);

let tmpDir = "";
let filePath = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-detached-"));
  filePath = path.join(tmpDir, "detached.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeRegistry(over: Partial<DetachedRegistryDeps> = {}): {
  registry: DetachedRegistry;
  readProcInfo: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const readProcInfo = vi.fn(
    over.readProcInfo ?? (() => ({ startTime: "100", cmdline: "sh -c x" })),
  );
  const kill = vi.fn(over.kill ?? (() => undefined));
  const registry = new DetachedRegistry({ filePath, readProcInfo, kill });
  return { registry, readProcInfo, kill };
}

function readFile(): Record<string, { pid: number; startTime: string; cmdline: string }> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    { pid: number; startTime: string; cmdline: string }
  >;
}

describe("DetachedRegistry record/remove", () => {
  it("records a pid with its captured start-time/cmdline", () => {
    const { registry } = makeRegistry({
      readProcInfo: () => ({ startTime: "555", cmdline: "sh -c node a.js" }),
    });
    registry.record(1234);
    expect(readFile()["1234"]).toEqual({ pid: 1234, startTime: "555", cmdline: "sh -c node a.js" });
  });

  it("stores empty identity when proc info is unavailable", () => {
    const { registry } = makeRegistry({ readProcInfo: () => null });
    registry.record(1234);
    expect(readFile()["1234"]).toEqual({ pid: 1234, startTime: "", cmdline: "" });
  });

  it("removes a recorded pid, leaving siblings intact", () => {
    const { registry } = makeRegistry();
    registry.record(1);
    registry.record(2);
    registry.remove(1);
    const data = readFile();
    expect(data["1"]).toBeUndefined();
    expect(data["2"]).toBeDefined();
  });

  it("remove on an absent pid is a no-op", () => {
    const { registry } = makeRegistry();
    registry.record(1);
    registry.remove(999);
    expect(Object.keys(readFile())).toEqual(["1"]);
  });
});

describe("defaultReadProcInfo platform dispatch", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("reads identity from `ps` on macOS (no /proc)", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockExecFileSync
      .mockReturnValueOnce("Mon Jun 30 14:51:34 2026\n")
      .mockReturnValueOnce("node worker.js\n");

    const info = defaultReadProcInfo(4321);

    expect(info).toEqual({ startTime: "Mon Jun 30 14:51:34 2026", cmdline: "node worker.js" });
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      "ps",
      ["-o", "lstart=", "-p", "4321"],
      expect.anything(),
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      "ps",
      ["-o", "command=", "-p", "4321"],
      expect.anything(),
    );
  });

  it("returns null on macOS when the pid is gone (`ps` throws)", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("No such process");
    });

    expect(defaultReadProcInfo(4321)).toBeNull();
  });
});

describe("DetachedRegistry reapOrphans", () => {
  it("SIGTERMs the process group when start-time AND cmdline still match", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "300": { pid: 300, startTime: "111", cmdline: "sh -c srv" } }),
    );
    const { registry, kill } = makeRegistry({
      readProcInfo: () => ({ startTime: "111", cmdline: "sh -c srv" }),
    });
    registry.reapOrphans();
    expect(kill).toHaveBeenCalledWith(-300, "SIGTERM");
    // File cleared after the scan.
    expect(readFile()).toEqual({});
  });

  it("does not kill when start-time differs (PID reuse)", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "300": { pid: 300, startTime: "111", cmdline: "sh -c srv" } }),
    );
    const { registry, kill } = makeRegistry({
      readProcInfo: () => ({ startTime: "999", cmdline: "sh -c srv" }),
    });
    registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
    expect(readFile()).toEqual({});
  });

  it("does not kill when cmdline differs (PID reuse)", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "300": { pid: 300, startTime: "111", cmdline: "sh -c srv" } }),
    );
    const { registry, kill } = makeRegistry({
      readProcInfo: () => ({ startTime: "111", cmdline: "sh -c OTHER" }),
    });
    registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill when the pid is gone (readProcInfo null)", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "300": { pid: 300, startTime: "111", cmdline: "sh -c srv" } }),
    );
    const { registry, kill } = makeRegistry({ readProcInfo: () => null });
    registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
  });

  it("swallows a kill that throws and still clears the file", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "300": { pid: 300, startTime: "111", cmdline: "sh -c srv" } }),
    );
    const { registry } = makeRegistry({
      readProcInfo: () => ({ startTime: "111", cmdline: "sh -c srv" }),
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(() => {
      registry.reapOrphans();
    }).not.toThrow();
    expect(readFile()).toEqual({});
  });

  it("treats a missing file as empty", () => {
    const { registry, kill } = makeRegistry();
    expect(() => {
      registry.reapOrphans();
    }).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores a corrupt file", () => {
    fs.writeFileSync(filePath, "{not json");
    const { registry, kill } = makeRegistry();
    registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
  });

  it("skips entries with a malformed shape", () => {
    fs.writeFileSync(filePath, JSON.stringify({ bad: { pid: "x" }, "5": 42 }));
    const { registry, kill } = makeRegistry();
    registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
  });
});
