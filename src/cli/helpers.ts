import path from "node:path";

import { discoverConfig } from "#src/config/discovery.js";
import { isDaemonRunning, socketPath } from "#src/daemon/lifecycle.js";
import { sessionId } from "#src/daemon/session.js";
import { getEnv } from "#src/lib/env.js";
import { ipcRequest, ipcStream } from "#src/lib/ipc/client.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";
import { currentSession, showEnv } from "#src/lib/tmux.js";

export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface SessionInfo {
  id: string;
  name: string;
  projectDir: string;
}

export interface SessionIpc {
  readonly sessionId: string;
  request(method: string, params?: unknown): Promise<IpcResponse>;
  stream(
    method: string,
    params: unknown,
    onEvent: (event: string, data: unknown) => void,
  ): Promise<IpcResponse>;
}

/**
 * Resolve how to invoke zaps as a spawnable argv: `{ file, args }`. Used to
 * spawn the daemon child without `shell: true` (a joined string would be exec'd
 * as a literal filename → ENOENT, E1).
 * - `ZAPS_COMMAND` env / native binary: a single executable, no extra args.
 * - Source run (node/tsx): the node binary plus the script path.
 */
export function resolveCommandArgv(): { file: string; args: string[] } {
  const zapsCommand = getEnv("ZAPS_COMMAND");
  if (zapsCommand) {
    return { file: zapsCommand, args: [] };
  }
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return { file: path.basename(process.execPath), args: [] };
  }
  return { file: process.argv[0], args: [process.argv[1]] };
}

/**
 * The zaps invocation as a single shell string (for tmux pane commands).
 */
export function resolveCommand(): string {
  const { file, args } = resolveCommandArgv();
  return [file, ...args].join(" ");
}

export function resolveRuntime(): string {
  const env = getEnv("ZAPS_RUNTIME");
  if (env) {
    return env;
  }
  if (process.argv[1]?.startsWith("/$bunfs/")) {
    return "native";
  }
  return "source";
}

export function resolveTargetSession(sessions: SessionInfo[], sessionArg?: string): SessionInfo {
  if (sessionArg) {
    // Priority: exact id → exact name → id prefix → name prefix
    const exactId = sessions.find((s) => s.id === sessionArg);
    if (exactId) {
      return exactId;
    }
    const exactName = sessions.find((s) => s.name === sessionArg);
    if (exactName) {
      return exactName;
    }
    const prefixMatches = sessions.filter(
      (s) => s.id.startsWith(sessionArg) || s.name.startsWith(sessionArg),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
    if (prefixMatches.length > 1) {
      const lines = prefixMatches.map((s) => `  ${s.id}  ${s.name}  ${s.projectDir}`).join("\n");
      throw new CliError(`Ambiguous session "${sessionArg}". Matches:\n${lines}`);
    }
    throw new CliError(`Session not found: ${sessionArg}`);
  }
  if (sessions.length === 1) {
    return sessions[0];
  }
  const cwd = process.cwd();
  const match = sessions.find((s) => s.projectDir === cwd);
  if (match) {
    return match;
  }
  const lines = sessions.map((s) => `  ${s.id}  ${s.name}  ${s.projectDir}`).join("\n");
  throw new CliError(`Multiple sessions running. Specify one:\n${lines}`);
}

export function resolveSessionId(): { configPath: string; id: string } {
  const cwd = process.cwd();
  const configPath = discoverConfig(cwd);
  if (!configPath) {
    throw new CliError("No .zaps.mts config found. Run `zaps init` to create one.");
  }
  return { configPath, id: sessionId(configPath) };
}

export function formatTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const cols = rows[0].length;
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < cols; i += 1) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ")).join("\n");
}

export async function withLegacyIpc<T>(fn: (ipc: SessionIpc) => Promise<T>): Promise<T> {
  if (!getEnv("TMUX")) {
    throw new CliError("Must be inside a tmux session.");
  }
  const tmuxSession = await currentSession();
  const legacySock = await showEnv(tmuxSession, "ZAPS_IPC_SOCKET");
  if (!legacySock) {
    throw new CliError("No running zaps instance found in this session.");
  }
  const ipc: SessionIpc = {
    sessionId: "",
    request: async (method, params?) => ipcRequest(legacySock, method, params),
    stream: async (method, params, onEvent) => ipcStream(legacySock, method, params, onEvent),
  };
  return fn(ipc);
}

export async function withDaemon<T>(
  fn: (ipc: SessionIpc) => Promise<T>,
  sessionArg?: string,
): Promise<T> {
  const sock = socketPath();
  if (!isDaemonRunning()) {
    if (sessionArg) {
      throw new CliError("No running daemon found.");
    }
    return withLegacyIpc(fn);
  }

  const id = await (async () => {
    if (sessionArg) {
      const res = await ipcRequest(sock, "session.list");
      if (res.error) {
        throw new CliError(`Error: ${res.error}`);
      }
      // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
      return resolveTargetSession(res.result as SessionInfo[], sessionArg).id;
    }
    const resolved = resolveSessionId().id;
    const res = await ipcRequest(sock, "session.list");
    if (res.error) {
      throw new CliError(`Error: ${res.error}`);
    }
    // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
    if (!(res.result as { id: string }[]).some((s) => s.id === resolved)) {
      throw new CliError("No running zaps session for this project.");
    }
    return resolved;
  })();

  const ipc: SessionIpc = {
    sessionId: id,
    request: async (method, params?) => ipcRequest(sock, method, params, 30_000, id),
    stream: async (method, params, onEvent) =>
      ipcStream(sock, method, params, onEvent, 120_000, id),
  };
  return fn(ipc);
}
