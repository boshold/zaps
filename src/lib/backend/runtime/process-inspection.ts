import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly pgid: number;
  readonly sid: number;
  readonly cmdline?: string;
}

interface ProcessInspectionDeps {
  readonly platform: NodeJS.Platform;
  readonly exec: (command: string, args: string[]) => Promise<string>;
  readonly readProc: (path: string) => Promise<string>;
}

type ProbeFailure = "unavailable" | "failed" | "invalid_output" | "unsupported_platform";

class ProcessInspectionError extends Error {
  public readonly probe: string;
  public readonly reason: ProbeFailure;

  public constructor(probe: string, reason: ProbeFailure, cause?: unknown) {
    super(`Process inspection ${probe}: ${reason}`, { cause });
    this.name = "ProcessInspectionError";
    this.probe = probe;
    this.reason = reason;
  }
}

const execFileAsync = promisify(execFile);

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function positiveInteger(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseLinuxIdentity(pid: number, stat: string): ProcessIdentity {
  const close = stat.lastIndexOf(") ");
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const pgid = positiveInteger(fields[2]);
  const sid = positiveInteger(fields[3]);
  const { 19: startTime } = fields;
  const statPid = positiveInteger(stat.slice(0, stat.indexOf(" (")));
  if (
    close === -1 ||
    statPid !== pid ||
    pgid === null ||
    sid === null ||
    !startTime ||
    !/^\d+$/.test(startTime)
  ) {
    throw new ProcessInspectionError("/proc/stat", "invalid_output");
  }
  return { pid, pgid, sid, startTime };
}

function parsePort(addr: string): number {
  const lastColon = addr.lastIndexOf(":");
  if (lastColon === -1) {
    return Number.NaN;
  }
  return Number.parseInt(addr.substring(lastColon + 1), 10);
}

/**
 * Get listening TCP ports from Linux ss output.
 */
function parseLinuxSs(output: string, pidSet: Set<number>): number[] {
  const ports: number[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    if (!line.includes("LISTEN")) {
      // Only process LISTEN lines
    } else {
      const fields = line.trim().split(/\s+/);
      const localAddr = fields.at(3);
      if (localAddr) {
        const port = parsePort(localAddr);
        if (!Number.isNaN(port)) {
          const pidMatches = line.matchAll(/pid=(?<pid>\d+)/g);
          for (const match of pidMatches) {
            const linePid = Number.parseInt(match.groups?.pid ?? "", 10);
            if (pidSet.has(linePid)) {
              ports.push(port);
              break;
            }
          }
        }
      }
    }
  }

  return ports;
}

/**
 * Get listening TCP ports from macOS lsof output.
 */
function parseDarwinLsof(output: string, pidSet: Set<number>): number[] {
  const ports: number[] = [];
  const lines = output.trim().split("\n");

  // Skip header
  for (let i = 1; i < lines.length; i += 1) {
    const fields = lines[i].trim().split(/\s+/);
    if (fields.length >= 9) {
      const pid = Number.parseInt(fields[1], 10);
      if (!Number.isNaN(pid) && pidSet.has(pid)) {
        // Find the address field (contains ":" but doesn't start with "(")
        let addrPart = "";
        for (let j = fields.length - 1; j >= 8; j -= 1) {
          if (fields[j].includes(":") && !fields[j].startsWith("(")) {
            addrPart = fields[j];
            break;
          }
        }
        const port = parsePort(addrPart);
        if (!Number.isNaN(port)) {
          ports.push(port);
        }
      }
    }
  }

  return ports;
}

function sameProcess(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return (
    expected.pid === actual.pid &&
    expected.startTime === actual.startTime &&
    expected.pgid === actual.pgid &&
    expected.sid === actual.sid
  );
}

function createProcessInspection(overrides: Partial<ProcessInspectionDeps> = {}) {
  const deps: ProcessInspectionDeps = {
    platform: overrides.platform ?? process.platform,
    exec:
      overrides.exec ??
      (async (probe, args) => {
        const { stdout } = await execFileAsync(probe, args);
        return stdout;
      }),
    readProc: overrides.readProc ?? (async (path) => readFile(path, "utf8")),
  };

  async function command(probe: string, args: string[], emptyExit = false): Promise<string> {
    try {
      return await deps.exec(probe, args);
    } catch (error) {
      const code = errorCode(error);
      if (
        emptyExit &&
        code === 1 &&
        typeof error === "object" &&
        error !== null &&
        "stdout" in error &&
        error.stdout === "" &&
        "stderr" in error &&
        error.stderr === ""
      ) {
        return "";
      }
      throw new ProcessInspectionError(probe, code === "ENOENT" ? "unavailable" : "failed", error);
    }
  }

  function supported(): void {
    if (deps.platform !== "linux" && deps.platform !== "darwin") {
      throw new ProcessInspectionError(deps.platform, "unsupported_platform");
    }
  }

  async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
    supported();
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProcessInspectionError("pid", "invalid_output");
    }
    if (deps.platform === "linux") {
      try {
        const stat = await deps.readProc(`/proc/${String(pid)}/stat`);
        const identity = parseLinuxIdentity(pid, stat);
        const rawCmdline = await deps.readProc(`/proc/${String(pid)}/cmdline`);
        const cmdline = rawCmdline.replaceAll("\0", " ").trim();
        const current = parseLinuxIdentity(pid, await deps.readProc(`/proc/${String(pid)}/stat`));
        return sameProcess(identity, current) ? { ...identity, cmdline } : null;
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") {
          return null;
        }
        if (error instanceof ProcessInspectionError) {
          throw error;
        }
        throw new ProcessInspectionError("/proc", "failed", error);
      }
    }
    const field = async (name: string): Promise<string> => {
      const output = await command("ps", ["-o", name, "-p", String(pid)], true);
      return output.trim();
    };
    const startTime = await field("lstart=");
    if (!startTime) {
      return null;
    }
    const groupOutput = await field("pgid=,sess=");
    if (!groupOutput) {
      return null;
    }
    const groups = groupOutput.split(/\s+/);
    const pgid = positiveInteger(groups[0]);
    const sid = positiveInteger(groups[1]);
    if (pgid === null || sid === null) {
      throw new ProcessInspectionError("ps", "invalid_output");
    }
    const cmdline = await field("command=");
    if ((await field("lstart=")) !== startTime) {
      return null;
    }
    return { pid, pgid, sid, startTime, cmdline };
  }

  async function processTable(): Promise<{ pid: number; ppid: number; sid: number }[]> {
    supported();
    const keyword = deps.platform === "darwin" ? "sess" : "sid";
    const output = await command("ps", ["-eo", `pid,ppid,${keyword}`]);
    const rows: { pid: number; ppid: number; sid: number }[] = [];
    for (const line of output.trim().split("\n").slice(1)) {
      if (!line.trim()) {
        continue;
      }
      const fields = line.trim().split(/\s+/);
      const pid = positiveInteger(fields[0]);
      const ppid = Number(fields[1]);
      const sid = Number(fields[2]);
      if (
        pid === null ||
        !Number.isSafeInteger(ppid) ||
        ppid < 0 ||
        !Number.isSafeInteger(sid) ||
        sid < 0
      ) {
        throw new ProcessInspectionError("ps", "invalid_output");
      }
      rows.push({ pid, ppid, sid });
    }
    if (!output.trim()) {
      throw new ProcessInspectionError("ps", "invalid_output");
    }
    return rows;
  }

  async function getDescendantPids(rootPid: number): Promise<number[]> {
    const rows = await processTable();
    const result = new Set<number>();
    if (rows.some((row) => row.pid === rootPid)) {
      result.add(rootPid);
    }
    for (const row of rows) {
      if (row.sid === rootPid) {
        result.add(row.pid);
      }
    }
    const queue = [rootPid];
    const visited = new Set<number>(queue);
    const children = new Map<number, number[]>();
    for (const row of rows) {
      const siblings = children.get(row.ppid) ?? [];
      siblings.push(row.pid);
      children.set(row.ppid, siblings);
    }
    for (const parent of queue) {
      for (const pid of children.get(parent) ?? []) {
        if (!visited.has(pid)) {
          visited.add(pid);
          result.add(pid);
          queue.push(pid);
        }
      }
    }
    return [...result];
  }

  // Candidates only: callers must verify recorded birth identities before signalling.
  async function getProcessMembers(identity: ProcessIdentity): Promise<ProcessIdentity[]> {
    const members: ProcessIdentity[] = [];
    for (const row of await processTable()) {
      if (row.sid !== identity.sid) {
        continue;
      }
      const member = await readProcessIdentity(row.pid);
      if (member && member.pgid === identity.pgid && member.sid === identity.sid) {
        members.push(member);
      }
    }
    return members;
  }

  async function getListeningPorts(pids: readonly number[]): Promise<number[]> {
    supported();
    if (pids.length === 0) {
      return [];
    }
    const pidSet = new Set(pids);
    const ports =
      deps.platform === "linux"
        ? parseLinuxSs(await command("ss", ["-tlnp"]), pidSet)
        : parseDarwinLsof(await command("lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"], true), pidSet);
    return [...new Set(ports)].toSorted((a, b) => a - b);
  }

  async function detectPortsForPid(rootPid: number): Promise<number[]> {
    return getListeningPorts(await getDescendantPids(rootPid));
  }

  return {
    readProcessIdentity,
    getProcessMembers,
    getDescendantPids,
    getListeningPorts,
    detectPortsForPid,
  };
}

export { createProcessInspection, ProcessInspectionError, sameProcess };
export type { ProcessIdentity, ProcessInspectionDeps, ProbeFailure };
