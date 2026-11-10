import { z } from "zod";

import { discoverConfig } from "#src/config/discovery.js";
import { loadProjectContext } from "#src/config/project-context.js";
import { sessionId } from "#src/daemon/session.js";
import { captureEnvironment } from "#src/lib/request-context.js";
import { CliError, findSessionByDir, resolveTargetSession } from "#src/lib/session/resolve.js";
import type { SessionInfo } from "#src/lib/session/resolve.js";

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
  configSessionId: () => string | Promise<string>;
}

/**
 * Running session for `sessionArg`/cwd; else a raw 12-hex `sessionArg` (stopped
 * session) or the cwd config id.
 */
async function resolveSentraSessionId(input: SentraSessionInput): Promise<string> {
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

/**
 * The id `zaps up` would mint in `cwd`: hash of config path + resolved project
 * dir, so it needs the config loaded (its `cwd` option moves the project dir).
 */
async function computeProjectSessionId(cwd: string): Promise<string> {
  const configPath = discoverConfig(cwd);
  if (!configPath) {
    throw new CliError("No .zaps.mts config found. Run `zaps init` to create one.");
  }
  const loaded = await loadProjectContext(configPath, cwd, captureEnvironment(), () => {
    /* Notices belong to `zaps up` */
  });
  return sessionId(configPath, loaded.config.projectDir);
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

export { computeProjectSessionId, describeSentraError, resolveSentraSessionId };
export type { SentraSessionInput };
