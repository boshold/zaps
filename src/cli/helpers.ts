import path from "node:path";

import { discoverConfig } from "#src/config/discovery.js";
import { isDaemonRunning, socketPath } from "#src/daemon/lifecycle.js";
import { sessionId } from "#src/daemon/session.js";
import { getEnv } from "#src/lib/env.js";
import { ipcRequest, ipcStream } from "#src/lib/ipc/client.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";

/**
 * Single source of truth for the "no daemon" error. Reused by every
 * daemon-requiring command (down/ls/logs/services/…) so the message is
 * identical everywhere (E7, P05-V01).
 */
export const DAEMON_NOT_RUNNING = "Daemon not running.";

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
  /** Tmux session hosting the panes — powers the `zaps ls` location column. */
  tmuxSession: string;
  /** True when zaps owns the hosting tmux session (managed-tmux mode). */
  managed: boolean;
  /** `%N` of the TUI pane, or null when the layout has none (re-attach target). */
  tuiPane: string | null;
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
    // Compiled single-file binary: re-exec THIS executable by its real path.
    // `process.execPath` is the binary itself for a bun-compiled exe — using its
    // Basename would hunt `$PATH` and could spawn a different/older `zaps` (or
    // None at all), so the daemon it forks would not be the binary the user ran.
    return { file: process.execPath, args: [] };
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

/**
 * Match a session by directory (E12): exact `projectDir === dir`, else the
 * deepest projectDir that `dir` sits inside (path.sep guard so `/foo` never
 * matches `/foobar`). Returns undefined when nothing matches. Shared by the CLI
 * (resolveTargetSession) and the MCP server so both resolve cwd identically.
 */
export function findSessionByDir(sessions: SessionInfo[], dir: string): SessionInfo | undefined {
  const exact = sessions.find((s) => s.projectDir === dir);
  if (exact) {
    return exact;
  }
  const prefixMatches = sessions.filter((s) => dir.startsWith(`${s.projectDir}${path.sep}`));
  if (prefixMatches.length === 0) {
    return undefined;
  }
  const [deepest] = prefixMatches.toSorted((a, b) => b.projectDir.length - a.projectDir.length);
  return deepest;
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
  const match = findSessionByDir(sessions, process.cwd());
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

/**
 * Parse a CLI numeric option that must be a finite integer > 0 (E13). Returns
 * the value, or null for anything invalid — `"abc"` (NaN), `"0"`, `"-5"`,
 * `"1.5"` (non-integer; `parseInt` would silently floor it). Callers turn null
 * into a usage error + exit 1.
 */
export function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Resolve a session id from a `session.list` result, validating existence (E8).
 * With an explicit arg, defers to `resolveTargetSession` (which throws for an
 * unknown arg). Without one, resolves this project's id and confirms it is
 * actually in the list — so callers fail fast instead of subscribing to a
 * nonexistent session.
 */
export function resolveListedSessionId(sessions: SessionInfo[], sessionArg?: string): string {
  if (sessionArg) {
    return resolveTargetSession(sessions, sessionArg).id;
  }
  const resolved = resolveSessionId().id;
  if (!sessions.some((s) => s.id === resolved)) {
    throw new CliError("No running zaps session for this project.");
  }
  return resolved;
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

export async function withDaemon<T>(
  fn: (ipc: SessionIpc) => Promise<T>,
  sessionArg?: string,
): Promise<T> {
  const sock = socketPath();
  if (!isDaemonRunning()) {
    throw new CliError(DAEMON_NOT_RUNNING);
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

export interface DownDeps {
  daemonRunning: () => boolean;
  socket: () => string;
  sessionArg?: string;
  listSessions: (sock: string) => Promise<IpcResponse>;
  destroy: (sock: string, id: string) => Promise<IpcResponse>;
  resolveProjectSessionId: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Core of `zaps down`, decoupled from `process.exit` so the exit-code matrix is
 * unit-testable (E16). Returns the process exit code: 0 only when a session was
 * actually destroyed; 1 when the daemon is absent, nothing matched, or destroy
 * failed. The daemon is the single source of truth — there is no pane fallback
 * (E7).
 */
export async function runDown(deps: DownDeps): Promise<number> {
  if (!deps.daemonRunning()) {
    deps.stderr(`${DAEMON_NOT_RUNNING}\n`);
    return 1;
  }
  const sock = deps.socket();
  const res = await deps.listSessions(sock);
  if (res.error) {
    deps.stderr(`Error: ${res.error}\n`);
    return 1;
  }
  // eslint-disable-next-line no-unsafe-type-assertion -- IPC boundary
  const sessions = res.result as SessionInfo[];
  let target: SessionInfo | undefined = undefined;
  try {
    target = deps.sessionArg
      ? resolveTargetSession(sessions, deps.sessionArg)
      : sessions.find((s) => s.id === deps.resolveProjectSessionId());
  } catch (error) {
    if (error instanceof CliError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (!target) {
    deps.stderr("No running zaps session for this project.\n");
    return 1;
  }
  const destroyRes = await deps.destroy(sock, target.id);
  if (destroyRes.error) {
    deps.stderr(`Error: ${destroyRes.error}\n`);
    return 1;
  }
  deps.stdout("Session destroyed.\n");
  return 0;
}
