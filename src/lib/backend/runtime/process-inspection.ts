import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

type ProcessSessionId = number | string;

interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly pgid: number;
  // Linux SID or opaque macOS hexadecimal session token.
  readonly sid: ProcessSessionId;
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

const DARWIN_IDENTITY =
  /^(?<pgid>\d+)\s+(?<sid>[\da-f]+)\s+(?<startTime>\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(?<cmdline>.*))?$/is;

function parseDarwinSession(value: string | undefined): string | null {
  return value && /^[\da-f]+$/i.test(value) ? value : null;
}

function parseLinuxIdentity(pid: number, stat: string): ProcessIdentity | null {
  const close = stat.lastIndexOf(") ");
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // Mid-reap tasks report pgid/sid 0 once detached; owned processes never have 0.
  if (close !== -1 && (fields[2] === "0" || fields[3] === "0")) {
    return null;
  }
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
    throw new ProcessInspectionError("/proc/stat", "invalid_output", stat.slice(0, 300));
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

function descendantTree(
  rows: readonly { pid: number; ppid: number }[],
  rootPid: number,
  excluded: readonly number[] = [],
): number[] {
  const blocked = new Set(excluded);
  const result = new Set<number>();
  const queue = [rootPid];
  if (rows.some((row) => row.pid === rootPid)) {
    result.add(rootPid);
  }
  for (const parent of queue) {
    for (const row of rows) {
      if (row.ppid === parent && !blocked.has(row.pid) && !result.has(row.pid)) {
        result.add(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return [...result];
}

function includeDescendantSessions(
  rows: readonly { pid: number; sid: ProcessSessionId }[],
  result: Set<number>,
  platform: NodeJS.Platform,
): void {
  if (platform !== "linux") {
    return;
  }
  for (const row of rows) {
    if (result.has(row.pid) && row.sid === row.pid) {
      for (const member of rows) {
        if (member.sid === row.sid) {
          result.add(member.pid);
        }
      }
    }
  }
}

function createProcessInspection(overrides: Partial<ProcessInspectionDeps> = {}) {
  const deps: ProcessInspectionDeps = {
    platform: overrides.platform ?? process.platform,
    exec:
      overrides.exec ??
      (async (probe, args) => {
        // C locale keeps BSD `lstart` at a fixed five-field shape.
        const { stdout } = await execFileAsync(probe, args, {
          env: { ...process.env, LC_ALL: "C" },
        });
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

  async function readLinuxIdentity(pid: number): Promise<ProcessIdentity | null> {
    try {
      const stat = await deps.readProc(`/proc/${String(pid)}/stat`);
      const identity = parseLinuxIdentity(pid, stat);
      if (!identity) {
        return null;
      }
      const rawCmdline = await deps.readProc(`/proc/${String(pid)}/cmdline`);
      const cmdline = rawCmdline.replaceAll("\0", " ").trim();
      const current = parseLinuxIdentity(pid, await deps.readProc(`/proc/${String(pid)}/stat`));
      return current && sameProcess(identity, current) ? { ...identity, cmdline } : null;
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

  async function readDarwinIdentity(pid: number): Promise<ProcessIdentity | null> {
    // One ps snapshot: each extra spawn costs tens of milliseconds on macOS.
    const raw = await command(
      "ps",
      ["-o", "pgid=,sess=,lstart=,command=", "-p", String(pid)],
      true,
    );
    const output = raw.trim();
    if (!output) {
      return null;
    }
    const groups = DARWIN_IDENTITY.exec(output)?.groups;
    const pgid = positiveInteger(groups?.pgid);
    const sid = parseDarwinSession(groups?.sid);
    const startTime = groups?.startTime;
    if (pgid === null || sid === null || !startTime) {
      throw new ProcessInspectionError("ps", "invalid_output");
    }
    return { pid, pgid, sid, startTime, cmdline: groups?.cmdline?.trim() ?? "" };
  }

  async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
    supported();
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProcessInspectionError("pid", "invalid_output");
    }
    return deps.platform === "linux" ? readLinuxIdentity(pid) : readDarwinIdentity(pid);
  }

  async function processTable(): Promise<{ pid: number; ppid: number; sid: ProcessSessionId }[]> {
    supported();
    const keyword = deps.platform === "darwin" ? "sess" : "sid";
    const output = await command("ps", ["-eo", `pid,ppid,${keyword}`]);
    const rows: { pid: number; ppid: number; sid: ProcessSessionId }[] = [];
    for (const line of output.trim().split("\n").slice(1)) {
      if (!line.trim()) {
        continue;
      }
      const fields = line.trim().split(/\s+/);
      const pid = positiveInteger(fields[0]);
      const ppid = Number(fields[1]);
      const sid = deps.platform === "darwin" ? parseDarwinSession(fields[2]) : Number(fields[2]);
      if (
        pid === null ||
        !Number.isSafeInteger(ppid) ||
        ppid < 0 ||
        sid === null ||
        (typeof sid === "number" && (!Number.isSafeInteger(sid) || sid < 0))
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

  async function includePaneGroup(
    rootPid: number,
    rootSession: ProcessSessionId | undefined,
    result: Set<number>,
  ): Promise<void> {
    if (deps.platform !== "linux" || rootSession === undefined || rootSession === rootPid) {
      return;
    }
    const identity = await readProcessIdentity(rootPid);
    if (identity?.pgid === rootPid) {
      for (const member of await getProcessMembers(identity)) {
        result.add(member.pid);
      }
    }
  }

  async function getDescendantTree(
    rootPid: number,
    excluded: readonly number[] = [],
  ): Promise<number[]> {
    return descendantTree(await processTable(), rootPid, excluded);
  }

  async function getDescendantPids(rootPid: number): Promise<number[]> {
    const rows = await processTable();
    const result = new Set<number>();
    const root = rows.find((row) => row.pid === rootPid);
    if (root) {
      result.add(rootPid);
    }
    const rootSession = deps.platform === "darwin" ? root?.sid : rootPid;
    for (const row of rows) {
      if (row.sid === rootSession) {
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
    includeDescendantSessions(rows, result, deps.platform);
    await includePaneGroup(rootPid, root?.sid, result);
    return [...result];
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
    getDescendantTree,
    getListeningPorts,
    detectPortsForPid,
  };
}

export { createProcessInspection, ProcessInspectionError, sameProcess };
export type { ProcessIdentity, ProcessInspectionDeps, ProcessSessionId, ProbeFailure };
