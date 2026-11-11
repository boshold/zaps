import { z } from "zod";

import { sessionId } from "#src/daemon/session.js";
import { parseSessionListEntry } from "#src/lib/backend/wire.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";

import { CliError, requestDaemon } from "./helpers.js";

function readDaemonResult(response: IpcResponse): unknown {
  if (response.error !== undefined) {
    const code = response.errorCode;
    throw new CliError(code ? `${code}: ${response.error}` : response.error);
  }
  return response.result;
}

type ListedSession = ReturnType<typeof parseSessionListEntry>;

async function listStartupSessions(sock: string): Promise<ListedSession[]> {
  const response = await requestDaemon(sock, "session.list");
  return z.array(z.unknown()).parse(readDaemonResult(response)).map(parseSessionListEntry);
}

function findStartupSession(sessions: ListedSession[], configPath: string, projectDir: string) {
  const id = sessionId(configPath, projectDir);
  const legacyId = sessionId(configPath);
  return (
    sessions.find((session) => session.id === id) ??
    sessions.find(
      (session) =>
        session.backend === "tmux" &&
        session.id === legacyId &&
        sessionId(session.configPath ?? configPath, session.projectDir) === id,
    )
  );
}

export { findStartupSession, listStartupSessions, readDaemonResult };
export type { ListedSession };
