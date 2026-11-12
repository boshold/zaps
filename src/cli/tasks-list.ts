import type { TaskConfig } from "#src/config/types.js";
import { buildTaskListEntries } from "#src/lib/task/list-entry.js";

import { CliError, DAEMON_NOT_RUNNING, NO_PROJECT_SESSION } from "./helpers.js";
import type { SessionIpc } from "./helpers.js";

interface TaskListDeps {
  withDaemon: (
    fn: (ipc: Pick<SessionIpc, "request">) => Promise<unknown>,
    sessionArg?: string,
  ) => Promise<unknown>;
  loadLocalTasks: () => Promise<Record<string, TaskConfig>>;
}

async function fromSession(ipc: Pick<SessionIpc, "request">): Promise<unknown> {
  const res = await ipc.request("tasks.list");
  if (res.error !== undefined) {
    throw new CliError(`Error: ${res.error}`);
  }
  return res.result;
}

/** `zaps tasks`: ask the session, or read the local config when none runs. */
async function listTasks(sessionArg: string | undefined, deps: TaskListDeps): Promise<unknown> {
  if (sessionArg) {
    return deps.withDaemon(fromSession, sessionArg);
  }
  try {
    return await deps.withDaemon(fromSession);
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      (error.message !== NO_PROJECT_SESSION && error.message !== DAEMON_NOT_RUNNING)
    ) {
      throw error;
    }
  }
  return buildTaskListEntries(await deps.loadLocalTasks());
}

export { listTasks };
export type { TaskListDeps };
