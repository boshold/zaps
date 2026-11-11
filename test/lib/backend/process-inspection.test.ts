import { describe, expect, it, vi } from "vitest";

import {
  ProcessInspectionError,
  createProcessInspection,
  sameProcess,
} from "../../../src/lib/backend/runtime/process-inspection.js";

function stat(pid = 100, pgid = 100, sid = 100, birth = "987654321") {
  return `${String(pid)} (worker (odd) name)) S 1 ${String(pgid)} ${String(sid)} ${Array.from({ length: 15 }, () => "0").join(" ")} ${birth} 0`;
}

function gone() {
  return Object.assign(new Error("gone"), { code: "ENOENT" });
}

function emptyExit() {
  return Object.assign(new Error("no matches"), { code: 1, stdout: "", stderr: "" });
}

describe("process identity", () => {
  it("reads Linux birth, groups and NUL-separated diagnostic argv despite parentheses", async () => {
    const readProc = vi.fn(async (path: string) =>
      path.endsWith("/stat") ? stat() : "node\0server.js\0",
    );
    const inspection = createProcessInspection({ platform: "linux", readProc });
    expect(await inspection.readProcessIdentity(100)).toEqual({
      pid: 100,
      pgid: 100,
      sid: 100,
      startTime: "987654321",
      cmdline: "node server.js",
    });
  });

  it("ignores mutable command text when comparing ownership", () => {
    const identity = { pid: 100, pgid: 100, sid: 100, startTime: "123", cmdline: "old" };
    expect(sameProcess(identity, { ...identity, cmdline: "new" })).toBe(true);
    for (const changed of [{ pid: 101 }, { pgid: 101 }, { sid: 101 }, { startTime: "124" }]) {
      expect(sameProcess(identity, { ...identity, ...changed })).toBe(false);
    }
  });

  it("returns null for disappeared Linux processes and identity replacement mid-read", async () => {
    const readProc = vi.fn<(path: string) => Promise<string>>().mockRejectedValue(gone());
    const inspection = createProcessInspection({ platform: "linux", readProc });
    expect(await inspection.readProcessIdentity(100)).toBeNull();
    readProc
      .mockResolvedValueOnce(stat())
      .mockResolvedValueOnce("node")
      .mockResolvedValueOnce(stat(100, 100, 100, "999"));
    expect(await inspection.readProcessIdentity(100)).toBeNull();
  });

  it("returns null for Linux tasks mid-reap whose groups read as zero", async () => {
    const readProc = vi.fn<(path: string) => Promise<string>>().mockResolvedValue(stat(100, 0, 0));
    const inspection = createProcessInspection({ platform: "linux", readProc });
    expect(await inspection.readProcessIdentity(100)).toBeNull();
    readProc
      .mockResolvedValueOnce(stat())
      .mockResolvedValueOnce("node")
      .mockResolvedValueOnce(stat(100, 100, 0));
    expect(await inspection.readProcessIdentity(100)).toBeNull();
    readProc.mockResolvedValue(
      "29925 (sh) X 0 -1 -1 0 -1 4227084 598 3415 0 0 0 0 1 1 20 0 0 0 37896 0 0",
    );
    expect(await inspection.readProcessIdentity(29_925)).toBeNull();
  });

  it("rejects malformed stat and denied proc reads conservatively", async () => {
    const readProc = vi.fn<(path: string) => Promise<string>>().mockResolvedValue("broken");
    const inspection = createProcessInspection({ platform: "linux", readProc });
    await expect(inspection.readProcessIdentity(100)).rejects.toMatchObject({
      reason: "invalid_output",
    });
    readProc.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(inspection.readProcessIdentity(100)).rejects.toMatchObject({
      probe: "/proc",
      reason: "failed",
    });
  });

  it("preserves opaque macOS birth strings and uses the process group as session token", async () => {
    const birth = "Tue Nov 10 09:08:07 2026";
    const exec = vi.fn(async () => `  100 ${birth} node renamed worker\n`);
    const inspection = createProcessInspection({ platform: "darwin", exec });
    expect(await inspection.readProcessIdentity(100)).toEqual({
      pid: 100,
      pgid: 100,
      sid: "100",
      startTime: birth,
      cmdline: "node renamed worker",
    });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith("ps", ["-o", "pgid=,lstart=,command=", "-p", "100"]);
  });

  it("keeps padded macOS birth days intact and tolerates an empty command", async () => {
    const birth = "Mon Nov  9 09:08:07 2026";
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async () => `100 ${birth}\n`,
    });
    expect(await inspection.readProcessIdentity(100)).toEqual({
      pid: 100,
      pgid: 100,
      sid: "100",
      startTime: birth,
      cmdline: "",
    });
  });

  it("distinguishes absent macOS PIDs from missing or failing ps", async () => {
    const exec = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(emptyExit());
    const inspection = createProcessInspection({ platform: "darwin", exec });
    expect(await inspection.readProcessIdentity(100)).toBeNull();
    exec.mockRejectedValue(gone());
    await expect(inspection.readProcessIdentity(100)).rejects.toMatchObject({
      probe: "ps",
      reason: "unavailable",
    });
    exec.mockRejectedValue(Object.assign(emptyExit(), { stderr: "permission denied" }));
    await expect(inspection.readProcessIdentity(100)).rejects.toMatchObject({ reason: "failed" });
  });
});

describe("process membership", () => {
  it.each(["linux", "darwin"] as const)(
    "walks descendants and includes reparented session members on %s",
    async (platform) => {
      const exec = vi.fn(
        async () =>
          "PID PPID SID\n2 0 0\n100 1 100\n200 100 100\n300 200 300\n400 1 100\n500 1 500",
      );
      const inspection = createProcessInspection({ platform, exec });
      expect(await inspection.getDescendantPids(100)).toEqual([100, 200, 400, 300]);
      expect(exec).toHaveBeenCalledWith("ps", [
        "-eo",
        `pid,ppid,${platform === "darwin" ? "pgid" : "sid"}`,
      ]);
    },
  );

  it("uses the root macOS session token for reparented members without numeric conversion", async () => {
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async () =>
        "PID PPID SESS\n100 1 ffffff123456a3f\n200 100 ffffff123456a3f\n300 1 ffffff123456a3f\n400 1 100\n500 1 ffffff123456a40",
    });
    expect(await inspection.getDescendantPids(100)).toEqual([100, 200, 300]);
    expect(await inspection.getDescendantPids(999)).toEqual([]);
  });

  it("compares opaque macOS member tokens consistently with captured identities", async () => {
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async (_command, args) => {
        if (args[0] === "-eo") {
          return "PID PPID PGID\n200 1 100\n300 1 100\n400 1 400";
        }
        return `${args[3] === "200" ? "100" : "300"} Tue Nov 10 09:08:07 2026 renamed`;
      },
    });
    const identity = { pid: 100, pgid: 100, sid: "100", startTime: "earlier" };
    const members = await inspection.getProcessMembers(identity);
    expect(members).toEqual([
      {
        pid: 200,
        pgid: 100,
        sid: "100",
        startTime: "Tue Nov 10 09:08:07 2026",
        cmdline: "renamed",
      },
    ]);
    const member = members.at(0);
    if (!member) {
      throw new Error("missing member");
    }
    expect(sameProcess(member, { ...member, cmdline: "changed" })).toBe(true);
    expect(sameProcess(member, { ...member, sid: "400" })).toBe(false);
  });

  it("rejects malformed macOS session tokens in identities and process tables", async () => {
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async (_command, args) => {
        if (args[0] === "-eo") {
          return "PID PPID SESS\n100 1 invalid";
        }
        return "100 invalid Tue Nov 10 09:08:07 2026 node";
      },
    });
    await expect(inspection.readProcessIdentity(100)).rejects.toMatchObject({
      reason: "invalid_output",
    });
    await expect(inspection.getDescendantPids(100)).rejects.toMatchObject({
      reason: "invalid_output",
    });
  });

  it("does not invent a vanished root but retains surviving session members", async () => {
    const inspection = createProcessInspection({
      platform: "linux",
      exec: async () => "PID PPID SID\n200 1 100\n300 1 300",
    });
    expect(await inspection.getDescendantPids(100)).toEqual([200]);
    expect(await inspection.getDescendantPids(999)).toEqual([]);
  });

  it("returns only live identities in the expected group and session", async () => {
    const inspection = createProcessInspection({
      platform: "linux",
      exec: async () => "PID PPID SID\n200 1 100\n300 1 100\n400 1 100\n500 1 500",
      readProc: async (path) => {
        if (path.includes("/400/")) {
          throw gone();
        }
        if (path.endsWith("cmdline")) {
          return "new title";
        }
        return path.includes("/200/") ? stat(200) : stat(300, 300);
      },
    });
    expect(
      await inspection.getProcessMembers({ pid: 100, pgid: 100, sid: 100, startTime: "123" }),
    ).toEqual([{ pid: 200, pgid: 100, sid: 100, startTime: "987654321", cmdline: "new title" }]);
  });

  it("reports unavailable ps and malformed process tables", async () => {
    const exec = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(gone());
    const inspection = createProcessInspection({ platform: "linux", exec });
    await expect(inspection.getDescendantPids(100)).rejects.toMatchObject({
      probe: "ps",
      reason: "unavailable",
    });
    exec.mockResolvedValue("PID PPID SID\nbad row");
    await expect(inspection.getDescendantPids(100)).rejects.toBeInstanceOf(ProcessInspectionError);
  });
});

describe("listening ports", () => {
  it("filters Linux PID sets and deduplicates/sorts IPv4 and IPv6 ports", async () => {
    const inspection = createProcessInspection({
      platform: "linux",
      exec: async () =>
        [
          'LISTEN 0 128 [::]:5432 *:* users:(("node",pid=100,fd=1),("node",pid=200,fd=2))',
          'LISTEN 0 128 127.0.0.1:3000 *:* users:(("node",pid=200,fd=1))',
          'LISTEN 0 128 *:3000 *:* users:(("node",pid=200,fd=2))',
          'LISTEN 0 128 *:9000 *:* users:(("node",pid=999,fd=1))',
        ].join("\n"),
    });
    expect(await inspection.getListeningPorts([200, 200])).toEqual([3000, 5432]);
  });

  it("filters macOS PID sets and deduplicates/sorts IPv4 and IPv6 ports", async () => {
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async () =>
        [
          "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
          "node 100 user 1u IPv6 123 0t0 TCP [::1]:5432 (LISTEN)",
          "node 100 user 2u IPv4 124 0t0 TCP *:3000 (LISTEN)",
          "node 100 user 3u IPv4 125 0t0 TCP *:3000 (LISTEN)",
          "node 999 user 4u IPv4 126 0t0 TCP *:9000 (LISTEN)",
        ].join("\n"),
    });
    expect(await inspection.getListeningPorts([100])).toEqual([3000, 5432]);
  });

  it.each(["linux", "darwin"] as const)("reports missing port utility on %s", async (platform) => {
    const exec = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(gone());
    const inspection = createProcessInspection({ platform, exec });
    await expect(inspection.getListeningPorts([100])).rejects.toMatchObject({
      probe: platform === "linux" ? "ss" : "lsof",
      reason: "unavailable",
    });
    expect(await inspection.getListeningPorts([])).toEqual([]);
  });

  it("propagates failed port probes and missing ps through PID detection", async () => {
    const exec = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(new Error("probe failed"));
    const inspection = createProcessInspection({ platform: "linux", exec });
    await expect(inspection.getListeningPorts([100])).rejects.toMatchObject({
      probe: "ss",
      reason: "failed",
    });
    exec.mockRejectedValue(gone());
    await expect(inspection.detectPortsForPid(100)).rejects.toMatchObject({
      probe: "ps",
      reason: "unavailable",
    });
  });

  it("allows lsof's no-listeners exit and reports unsupported platforms", async () => {
    const inspection = createProcessInspection({
      platform: "darwin",
      exec: async () => {
        throw emptyExit();
      },
    });
    expect(await inspection.getListeningPorts([100])).toEqual([]);
    await expect(
      createProcessInspection({ platform: "freebsd" }).getListeningPorts([100]),
    ).rejects.toMatchObject({ reason: "unsupported_platform" });
  });

  it("detects ports for an explicit PID without any pane target", async () => {
    const exec = vi.fn(async (command: string) =>
      command === "ps"
        ? "PID PPID SID\n100 1 100\n200 100 100"
        : 'LISTEN 0 128 *:8080 *:* users:(("node",pid=200,fd=1))',
    );
    expect(
      await createProcessInspection({ platform: "linux", exec }).detectPortsForPid(100),
    ).toEqual([8080]);
  });
});
