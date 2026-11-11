import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile:
    vi.fn<(command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node:util", () => ({ promisify: () => mockExecFile }));

vi.mock("../../src/lib/tmux.js", () => ({
  panePid: vi.fn(),
}));

import { detectPorts, getDescendantPids, getListeningPorts } from "../../src/lib/port.js";
import { panePid } from "../../src/lib/tmux.js";

const mockPanePid = vi.mocked(panePid);

function mockExecFileOutput(output: string): void {
  mockExecFile.mockResolvedValue({ stdout: output, stderr: "" });
}

function mockExecFileError(): void {
  mockExecFile.mockRejectedValue(new Error("command not found"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDescendantPids", () => {
  it("collects descendants from ps output", async () => {
    const psOutput = [
      "  PID  PPID   SID",
      " 1000     1  1000",
      " 2000  1000  1000",
      " 3000  2000  1000",
      " 4000  1000  1000",
      " 5000     1  5000",
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

  it("finds reparented child via SID match", async () => {
    // PID 3000 was reparented to PID 1 (parent exited) but retains SID 1000
    const psOutput = [
      "  PID  PPID   SID",
      " 1000     1  1000",
      " 3000     1  1000",
      " 5000     1  5000",
    ].join("\n");

    mockExecFileOutput(psOutput);

    const result = await getDescendantPids(1000);
    expect(result).toContain(1000);
    expect(result).toContain(3000);
    expect(result).not.toContain(5000);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when ps fails", async () => {
    mockExecFileError();
    const result = await getDescendantPids(1000);
    expect(result).toEqual([]);
  });

  it("returns just root when no children", async () => {
    const psOutput = ["  PID  PPID   SID", " 1000     1  1000", " 2000     1  2000"].join("\n");

    mockExecFileOutput(psOutput);

    const result = await getDescendantPids(1000);
    expect(result).toEqual([1000]);
  });

  describe("ps session-id keyword is platform-specific", () => {
    const C_LOCALE = { env: expect.objectContaining({ LC_ALL: "C" }) };
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });

    it("uses the `sid` keyword on Linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      mockExecFileOutput("  PID  PPID   SID\n 1000     1  1000");
      await getDescendantPids(1000);
      expect(mockExecFile).toHaveBeenCalledWith("ps", ["-eo", "pid,ppid,sid"], C_LOCALE);
    });

    it("uses the process group on macOS (BSD ps reports sess 0)", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockExecFileOutput("  PID  PPID  PGID\n 1000     1  1000");
      await getDescendantPids(1000);
      expect(mockExecFile).toHaveBeenCalledWith("ps", ["-eo", "pid,ppid,pgid"], C_LOCALE);
    });
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

  it("detects ports for macOS descendants and reparented session members", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockPanePid.mockResolvedValue(1000);
    mockExecFile
      .mockResolvedValueOnce({
        stdout: "PID PPID SESS\n1000 1 a3f\n2000 1000 a3f\n3000 1 a3f\n4000 1 a40",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: [
          "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
          "node 2000 user 1u IPv4 123 0t0 TCP *:3000 (LISTEN)",
          "node 3000 user 2u IPv6 124 0t0 TCP [::1]:8080 (LISTEN)",
          "node 4000 user 3u IPv4 125 0t0 TCP *:9000 (LISTEN)",
        ].join("\n"),
        stderr: "",
      });
    expect(await detectPorts("%0", { panePid: mockPanePid })).toEqual([3000, 8080]);
  });

  it("deduplicates and sorts ports", async () => {
    mockPanePid.mockResolvedValue(1000);

    // First call: ps for getDescendantPids
    // Second call: ss for getListeningPorts
    let callCount = 0;
    mockExecFile.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Ps output
        return { stdout: "  PID  PPID   SID\n 1000     1  1000\n 2000  1000  1000\n", stderr: "" };
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

    const result = await detectPorts("%0", { panePid: mockPanePid });
    expect(result).toEqual([3000, 5432]);
  });
});
