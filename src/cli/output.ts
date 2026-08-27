import { encode } from "@toon-format/toon";

type OutputFormat = "text" | "json" | "toon";

const AGENT_ENV_VARS = [
  "CLAUDECODE", // Claude Code
  "CURSOR_TRACE_DIR", // Cursor IDE
];

function isCodingAgent(): boolean {
  return AGENT_ENV_VARS.some((key) => process.env[key]);
}

function resolveFormat(opts: { json?: boolean; toon?: boolean }): OutputFormat {
  if (opts.json) {
    return "json";
  }
  if (opts.toon) {
    return "toon";
  }
  const envFormat = process.env.ZAPS_FORMAT;
  if (envFormat === "json" || envFormat === "toon") {
    return envFormat;
  }
  if (isCodingAgent()) {
    return "toon";
  }
  return "text";
}

/** What `zaps ls` needs from a session to render one row. */
interface SessionRowData {
  id: string;
  name: string;
  projectDir: string;
  tmuxSession?: string;
  managed?: boolean;
}

/**
 * The LOCATION cell for a session: the tmux session hosting it, marked when zaps
 * owns that tmux (so `zaps down` there also takes the tmux session with it).
 * Empty when an older daemon didn't report one.
 */
function sessionLocation(session: SessionRowData): string {
  if (!session.tmuxSession) {
    return "";
  }
  return session.managed ? `${session.tmuxSession} (managed)` : session.tmuxSession;
}

/**
 * Rows for the `zaps ls` table: id, name, project dir, location. Column-aligned
 * and header-less, exactly as before — only the LOCATION cell is new.
 */
function sessionRows(sessions: SessionRowData[]): string[][] {
  return sessions.map((s) => [s.id, s.name, s.projectDir, sessionLocation(s)]);
}

function writeData(data: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else if (format === "toon") {
    process.stdout.write(`${encode(data)}\n`);
  }
}

export { isCodingAgent, resolveFormat, sessionLocation, sessionRows, writeData };
export type { OutputFormat, SessionRowData as SessionRow };
