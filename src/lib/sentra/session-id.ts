import { z } from "zod";

import { findSessionByDir, resolveTargetSession } from "#src/cli/helpers.js";
import type { SessionInfo } from "#src/cli/helpers.js";

const SESSION_ID = /^[0-9a-f]{12}$/;
const OLD_DAEMON = "This daemon is older than the CLI. Run `zaps daemon stop` and start again.";

const sessionListSchema = z.array(
  z.object({ id: z.string(), name: z.string(), projectDir: z.string() }),
);

interface SentraSessionInput {
  /** Raw `session.list` result. */
  sessions: unknown;
  sessionArg?: string;
  cwd: string;
  /** Id computed from the cwd config; throws without config. */
  configSessionId: () => string;
}

/**
 * Running session for `sessionArg`/cwd; else a raw 12-hex `sessionArg` (stopped
 * session) or the cwd config id.
 */
function resolveSentraSessionId(input: SentraSessionInput): string {
  const sessions: SessionInfo[] = sessionListSchema.parse(input.sessions);
  const { sessionArg } = input;
  if (sessionArg) {
    if (SESSION_ID.test(sessionArg) && !sessions.some((s) => s.id.startsWith(sessionArg))) {
      return sessionArg;
    }
    return resolveTargetSession(sessions, sessionArg).id;
  }
  return findSessionByDir(sessions, input.cwd)?.id ?? input.configSessionId();
}

/** Maps a daemon error string to the user message and CLI exit code. */
function describeSentraError(error: string): { message: string; code: number } {
  if (error.startsWith("Unknown method: sentra.")) {
    return { message: OLD_DAEMON, code: 1 };
  }
  const match =
    /^(?<prefix>sentra_disabled|sentra_unavailable|invalid_filter|not_found): (?<message>[\s\S]*)$/.exec(
      error,
    );
  const prefix = match?.groups?.prefix;
  const message = match?.groups?.message;
  if (prefix === undefined || message === undefined) {
    return { message: error, code: 1 };
  }
  if (prefix === "sentra_unavailable") {
    return { message: `Sentra is unavailable: ${message}`, code: 1 };
  }
  return { message, code: prefix === "invalid_filter" ? 2 : 1 };
}

export { describeSentraError, resolveSentraSessionId };
export type { SentraSessionInput };
