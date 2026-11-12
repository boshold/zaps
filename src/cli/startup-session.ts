import { sessionId } from "#src/daemon/session.js";
import { parseSessionList } from "#src/lib/backend/wire.js";
import { readResult as readDaemonResult } from "#src/lib/session/implicit.js";

import { requestDaemon } from "./helpers.js";

type ListedSession = ReturnType<typeof parseSessionList>[number];

async function listStartupSessions(sock: string): Promise<ListedSession[]> {
  const response = await requestDaemon(sock, "session.list");
  return parseSessionList(readDaemonResult(response));
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
