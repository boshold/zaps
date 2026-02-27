import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process and tmux
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: any) => fn,
}));

vi.mock("../../src/lib/tmux.js", () => ({
  panePid: vi.fn(),
}));

import { execFile } from "node:child_process";

import { detectPorts, getDescendantPids, getListeningPorts } from "../../src/lib/port.js";
import { panePid } from "../../src/lib/tmux.js";

const mockExecFile = vi.mocked(execFile);
const mockPanePid = vi.mocked(panePid);

function mockExecFileOutput(output: string): void {
  (mockExecFile as any).mockResolvedValue({ stdout: output, stderr: "" });
}

function mockExecFileError(): void {
  (mockExecFile as any).mockRejectedValue(new Error("command not found"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDescendantPids", () => {
  it("collects descendants from ps output", async () => {
    const psOutput = [
      "  PID  PPID",
      " 1000     1",
      " 2000  1000",
      " 3000  2000",
      " 4000  1000",
      " 5000     1",
    ].join("\n");

    mockExecFileOutput(psOutput);

    const result = await getDescendantPids(1000);
    expect(result).toContain(1000);
    expect(result).toContain(2000);
    expect(result).toContain(3000);
    expect(result).toContain(4000);
    expect(result).not.toContain(5000);
    expect(result).toHaveLength(4);
  });

  it("returns empty array when ps fails", async () => {
    mockExecFileError();
    const result = await getDescendantPids(1000);
    expect(result).toEqual([]);
  });

  it("returns just root when no children", async () => {
    const psOutput = ["  PID  PPID", " 1000     1", " 2000     1"].join("\n");

    mockExecFileOutput(psOutput);

    const result = await getDescendantPids(1000);
    expect(result).toEqual([1000]);
  });
});

describe("getListeningPorts — Linux", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("extracts ports from ss output", async () => {
    const ssOutput = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      128    0.0.0.0:5432        0.0.0.0:*        users:(("postgres",pid=1234,fd=5))',
      'LISTEN 0      128    0.0.0.0:3000        0.0.0.0:*        users:(("node",pid=5678,fd=7))',
    ].join("\n");

    mockExecFileOutput(ssOutput);

    const result = await getListeningPorts([1234, 5678]);
    expect(result).toContain(5432);
    expect(result).toContain(3000);
  });

  it("filters by PID set", async () => {
    const ssOutput = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      128    0.0.0.0:5432        0.0.0.0:*        users:(("postgres",pid=1234,fd=5))',
      'LISTEN 0      128    0.0.0.0:3000        0.0.0.0:*        users:(("node",pid=5678,fd=7))',
    ].join("\n");

    mockExecFileOutput(ssOutput);

    // Only include PID 1234
    const result = await getListeningPorts([1234]);
    expect(result).toEqual([5432]);
  });

  it("returns empty array when ss fails", async () => {
    mockExecFileError();
    const result = await getListeningPorts([1234]);
    expect(result).toEqual([]);
  });

  it("skips addresses with no colon", async () => {
    const ssOutput = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      128    nocolon             0.0.0.0:*        users:(("node",pid=1234,fd=5))',
      'LISTEN 0      128    0.0.0.0:3000        0.0.0.0:*        users:(("node",pid=1234,fd=7))',
    ].join("\n");

    mockExecFileOutput(ssOutput);

    const result = await getListeningPorts([1234]);
    expect(result).toEqual([3000]);
  });

  it("handles multiple PIDs in one line", async () => {
    const ssOutput = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      128    0.0.0.0:5432        0.0.0.0:*        users:(("postgres",pid=1234,fd=5),("postgres",pid=1235,fd=6))',
    ].join("\n");

    mockExecFileOutput(ssOutput);

    const result = await getListeningPorts([1235]);
    expect(result).toEqual([5432]);
  });
});

describe("getListeningPorts — macOS", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("extracts ports from lsof output", async () => {
    const lsofOutput = [
      "COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "postgres  1234  user   5u   IPv4  12345  0t0      TCP  *:5432 (LISTEN)",
      "node      5678  user   7u   IPv4  12346  0t0      TCP  *:3000 (LISTEN)",
    ].join("\n");

    mockExecFileOutput(lsofOutput);

    const result = await getListeningPorts([1234, 5678]);
    expect(result).toContain(5432);
    expect(result).toContain(3000);
  });

  it("filters by PID set", async () => {
    const lsofOutput = [
      "COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "postgres  1234  user   5u   IPv4  12345  0t0      TCP  *:5432 (LISTEN)",
      "node      5678  user   7u   IPv4  12346  0t0      TCP  *:3000 (LISTEN)",
    ].join("\n");

    mockExecFileOutput(lsofOutput);

    const result = await getListeningPorts([5678]);
    expect(result).toEqual([3000]);
  });

  it("returns empty array when lsof fails", async () => {
    mockExecFileError();
    const result = await getListeningPorts([1234]);
    expect(result).toEqual([]);
  });

  it("skips short lines with fewer than 9 fields", async () => {
    const lsofOutput = [
      "COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
      "short line",
      "postgres  1234  user   5u   IPv4  12345  0t0      TCP  *:5432 (LISTEN)",
    ].join("\n");

    mockExecFileOutput(lsofOutput);

    const result = await getListeningPorts([1234]);
    expect(result).toEqual([5432]);
  });
});

describe("getListeningPorts — unsupported platform", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("returns empty array on unsupported platform", async () => {
    const result = await getListeningPorts([1234]);
    expect(result).toEqual([]);
  });
});

describe("detectPorts", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("deduplicates and sorts ports", async () => {
    mockPanePid.mockResolvedValue(1000);

    // First call: ps for getDescendantPids
    // Second call: ss for getListeningPorts
    let callCount = 0;
    (mockExecFile as any).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Ps output
        return { stdout: "  PID  PPID\n 1000     1\n 2000  1000\n", stderr: "" };
      }
      // Ss output — same port from two PIDs
      return {
        stdout: [
          "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
          'LISTEN 0      128    0.0.0.0:3000        0.0.0.0:*        users:(("node",pid=1000,fd=5))',
          'LISTEN 0      128    0.0.0.0:3000        0.0.0.0:*        users:(("node",pid=2000,fd=6))',
          'LISTEN 0      128    0.0.0.0:5432        0.0.0.0:*        users:(("pg",pid=2000,fd=7))',
        ].join("\n"),
        stderr: "",
      };
    });

    const result = await detectPorts("%0");
    expect(result).toEqual([3000, 5432]);
  });
});
