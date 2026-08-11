import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TmuxHandle } from "./tmux.js";

/** The tmux command port detection issues. */
type PortTmux = Pick<TmuxHandle, "panePid">;

const execFileAsync = promisify(execFile);

/**
 * Execute a system command and return stdout. Returns empty string on error.
 */
async function exec(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Parse a port number from a local address string (e.g., "0.0.0.0:5432").
 * Returns NaN if parsing fails.
 */
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

/**
 * Get all descendant PIDs of a root PID using ps.
 * Returns array including rootPid itself.
 */
async function getDescendantPidsImpl(rootPid: number): Promise<number[]> {
  // Linux/procps spells the session-id column `sid`; BSD `ps` (macOS) rejects
  // That keyword ("ps: keyword sid not found"), exits non-zero, and the call
  // Yields "" — losing the whole process tree, so every paned service looks
  // Crashed ("Process exited unexpectedly") and port detection finds nothing.
  // The BSD session-id keyword is `sess`. Pick per-platform, mirroring
  // GetListeningPortsImpl below.
  const sessionKeyword = process.platform === "darwin" ? "sess" : "sid";
  const output = await exec("ps", ["-eo", `pid,ppid,${sessionKeyword}`]);
  if (!output) {
    return [];
  }

  // Build parent -> children map and collect SID matches
  const childrenMap = new Map<number, number[]>();
  const sidMatches = new Set<number>();
  const lines = output.trim().split("\n");

  // Skip header
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 3) {
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      const sid = Number.parseInt(parts[2], 10);
      if (!Number.isNaN(pid) && !Number.isNaN(ppid)) {
        const existing = childrenMap.get(ppid);
        if (existing) {
          existing.push(pid);
        } else {
          childrenMap.set(ppid, [pid]);
        }
        // Collect processes sharing the same session as rootPid.
        // Tmux panes run in their own session, so SID == pane shell PID.
        // This catches child processes reparented to PID 1 when their
        // Parent exits (e.g., wrapper scripts that background a server).
        if (!Number.isNaN(sid) && sid === rootPid) {
          sidMatches.add(pid);
        }
      }
    }
  }

  // BFS walk from rootPid
  const result = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== "number") {
      break;
    }
    const kids = childrenMap.get(current) ?? [];
    for (const kid of kids) {
      result.add(kid);
      queue.push(kid);
    }
  }

  // Union BFS descendants with SID-matched processes
  for (const pid of sidMatches) {
    result.add(pid);
  }

  return [...result];
}

/**
 * Get listening TCP ports for a set of PIDs.
 * Uses ss on Linux, lsof on macOS.
 */
async function getListeningPortsImpl(pids: number[]): Promise<number[]> {
  const pidSet = new Set(pids);

  if (process.platform === "linux") {
    const output = await exec("ss", ["-tlnp"]);
    if (!output) {
      return [];
    }
    return parseLinuxSs(output, pidSet);
  }

  if (process.platform === "darwin") {
    const output = await exec("lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"]);
    if (!output) {
      return [];
    }
    return parseDarwinLsof(output, pidSet);
  }

  return [];
}

/**
 * Detect listening ports for a tmux pane's process tree.
 * Returns deduplicated sorted port list.
 */
async function detectPortsImpl(paneTarget: string, tmux: PortTmux): Promise<number[]> {
  const rootPid = await tmux.panePid(paneTarget);
  const pids = await getDescendantPidsImpl(rootPid);
  const ports = await getListeningPortsImpl(pids);
  return [...new Set(ports)].toSorted((a, b) => a - b);
}

/**
 * Detect listening ports for a process tree rooted at an explicit PID — used for
 * detached services, which have no pane to derive the root PID from (E4).
 * Returns deduplicated sorted port list.
 */
async function detectPortsForPidImpl(rootPid: number): Promise<number[]> {
  const pids = await getDescendantPidsImpl(rootPid);
  const ports = await getListeningPortsImpl(pids);
  return [...new Set(ports)].toSorted((a, b) => a - b);
}

export {
  getDescendantPidsImpl as getDescendantPids,
  getListeningPortsImpl as getListeningPorts,
  detectPortsImpl as detectPorts,
  detectPortsForPidImpl as detectPortsForPid,
};
