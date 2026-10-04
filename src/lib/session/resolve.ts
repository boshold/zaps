import path from "node:path";

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
  configPath?: string;
  /**
   * Tmux session hosting the panes — powers the `zaps ls` location column.
   * Optional at runtime: a daemon from an older release omits it, and the CLI
   * must degrade (blank location) rather than crash mid-command.
   */
  tmuxSession?: string;
  /** True when zaps owns the hosting tmux session (managed-tmux mode). */
  managed?: boolean;
  /** `%N` of the TUI pane, or null when the layout has none (re-attach target). */
  tuiPane?: string | null;
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
