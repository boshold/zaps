import { z } from "zod";

import { taskPreflightSchema } from "#src/lib/backend/wire.js";
import type { ImplicitSessionOptions } from "#src/lib/session/implicit.js";

import { CliError, DAEMON_NOT_RUNNING, NO_PROJECT_SESSION } from "./helpers.js";
import type { SessionIpc } from "./helpers.js";
import { writeData } from "./output.js";
import type { OutputFormat } from "./output.js";

interface RunTaskIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  data: (data: unknown, format: OutputFormat) => void;
}

const serviceEventSchema = z.object({
  name: z.string(),
  phase: z.enum(["starting", "waiting", "ready"]),
});

const runResultSchema = z.object({ success: z.boolean() });

const defaultIo: RunTaskIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  data: writeData,
};

/** `--start` → true, `--no-start` → false, neither → undefined (follow config). */
function resolveStartFlag(flags: { start?: boolean; noStart?: boolean }): boolean | undefined {
  if (flags.start && flags.noStart) {
    throw new CliError("Error: --start and --no-start cannot be used together.");
  }
  if (flags.start) {
    return true;
  }
  return flags.noStart ? false : undefined;
}

/** Prints each service/phase line once; heartbeats repeat events and are dropped. */
function createServiceProgressPrinter(write: (text: string) => void): (data: unknown) => void {
  const seen = new Set<string>();
  return (data) => {
    const parsed = serviceEventSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const { name, phase } = parsed.data;
    const id = `${name}\0${phase}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const line = {
      starting: `Starting ${name}…`,
      waiting: `Waiting for ${name}…`,
      ready: `${name} ready`,
    }[phase];
    write(`${line}\n`);
  };
}

async function notRunningServices(ipc: Pick<SessionIpc, "request">, key: string) {
  try {
    const res = await ipc.request("tasks.preflight", { key });
    const parsed = taskPreflightSchema.safeParse(res.result);
    if (parsed.success) {
      return parsed.data.services.filter((s) => s.action === "start").map((s) => s.name);
    }
  } catch {
    /* Hint is best-effort. */
  }
  return [];
}

const IMPLICIT_START_HINT = 'Rerun with --start, or run "zaps up" first.';

/** The session vanished before the request reached it (ephemeral auto-destroy). */
class SessionGoneError extends Error {
  public override readonly name = "SessionGoneError";
}

/** Only sent before task execution starts, so a retry cannot run the task twice. */
function isSessionGone(res: { error?: string }): boolean {
  return res.error === "Unknown session";
}

function startHint(names: readonly string[]): string {
  const target = names.length > 0 ? names.join(" ") : "<services>";
  return `Start them with "zaps start ${target}" or rerun with --start.`;
}

interface RunTaskOptions {
  key: string;
  start?: boolean;
  format: OutputFormat;
  /** Session was created for this call; `zaps start` hints would not work. */
  implicit?: boolean;
  /** Throw `SessionGoneError` instead of reporting a vanished session. */
  retryable?: boolean;
}

/** Run a task over IPC; returns the process exit code. */
async function runTask(
  ipc: Pick<SessionIpc, "request" | "stream">,
  options: RunTaskOptions,
  io: RunTaskIo = defaultIo,
): Promise<number> {
  const { key, start, format } = options;
  const printProgress = createServiceProgressPrinter(io.stderr);
  const res = await ipc.stream(
    "tasks.run",
    start === undefined ? { key } : { key, start },
    (event, data) => {
      if (event === "service") {
        printProgress(data);
      } else if (format === "text" && event === "line" && typeof data === "string") {
        io.stdout(`${data}\n`);
      }
    },
  );
  if (res.error !== undefined) {
    if (options.retryable && isSessionGone(res)) {
      throw new SessionGoneError(res.error);
    }
    io.stderr(`Error: ${res.error}\n`);
    if (res.errorCode === "services_not_running") {
      const hint = options.implicit
        ? IMPLICIT_START_HINT
        : startHint(await notRunningServices(ipc, key));
      io.stderr(`${hint}\n`);
    }
    return 1;
  }
  if (format !== "text") {
    io.data(res.result, format);
    return 0;
  }
  if (!runResultSchema.parse(res.result).success) {
    io.stderr("Task failed.\n");
    return 1;
  }
  return 0;
}

interface RunTaskCommandDeps {
  withDaemon: (
    fn: (ipc: Pick<SessionIpc, "request" | "stream">) => Promise<number>,
    sessionArg?: string,
  ) => Promise<number>;
  ensureImplicitSession: (
    options: ImplicitSessionOptions,
  ) => Promise<{ sessionId: string; socketPath: string }>;
  ensureDaemon: () => Promise<string>;
  sessionIpc: (sock: string, id: string) => Pick<SessionIpc, "request" | "stream">;
  cwd: () => string;
}

function isMissingSession(error: unknown): boolean {
  return (
    error instanceof CliError &&
    (error.message === NO_PROJECT_SESSION || error.message === DAEMON_NOT_RUNNING)
  );
}

async function runImplicit(
  options: RunTaskOptions,
  deps: RunTaskCommandDeps,
  io: RunTaskIo,
  retryable: boolean,
): Promise<number> {
  const { sessionId, socketPath } = await deps.ensureImplicitSession({
    cwd: deps.cwd(),
    ensureDaemon: deps.ensureDaemon,
    task: options.key,
  });
  return runTask(
    deps.sessionIpc(socketPath, sessionId),
    { ...options, implicit: true, retryable },
    io,
  );
}

/**
 * `zaps run`: use the project's session, or create an implicit one. A session
 * that vanishes before the request reaches it is retried once.
 */
async function runTaskCommand(
  options: RunTaskOptions & { sessionArg?: string },
  deps: RunTaskCommandDeps,
  io: RunTaskIo = defaultIo,
): Promise<number> {
  const { sessionArg, ...run } = options;
  if (sessionArg) {
    return deps.withDaemon(async (ipc) => runTask(ipc, run, io), sessionArg);
  }
  const retryOnce = async (attempt: () => Promise<number>): Promise<number> => {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof SessionGoneError) {
        return runImplicit(run, deps, io, false);
      }
      throw error;
    }
  };
  try {
    return await retryOnce(async () =>
      deps.withDaemon(async (ipc) => runTask(ipc, { ...run, retryable: true }, io)),
    );
  } catch (error) {
    if (!isMissingSession(error)) {
      throw error;
    }
  }
  return retryOnce(async () => runImplicit(run, deps, io, true));
}

export {
  SessionGoneError,
  createServiceProgressPrinter,
  resolveStartFlag,
  runTask,
  runTaskCommand,
};
export type { RunTaskCommandDeps, RunTaskIo };
