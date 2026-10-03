import { cli, command } from "cleye";
import type { z } from "zod";

import { CliError, DAEMON_NOT_RUNNING } from "#src/cli/helpers.js";
import { runLive } from "#src/cli/sentra-live.js";
import type { LiveDeps } from "#src/cli/sentra-live.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";
import {
  buildNextCommand,
  renderErrors,
  renderIssues,
  renderShow,
} from "#src/lib/sentra/render.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clearResultSchema,
  errorsResultSchema,
  issuesResultSchema,
  itemKindSchema,
  levelSchema,
  showResultSchema,
} from "#src/lib/sentra/schemas.js";
import type { ErrorsParams, IssuesParams } from "#src/lib/sentra/schemas.js";
import { describeSentraError, resolveSentraSessionId } from "#src/lib/sentra/session-id.js";
import { parseTimeInput, resolveTimeWindow } from "#src/lib/sentra/time.js";

const LEVEL_LIST = levelSchema.options.join(", ");
const KIND_LIST = itemKindSchema.options.join(", ");

/** Invalid flags; exit 2. */
class SentraUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SentraUsageError";
  }
}

interface SentraCliDeps {
  /** IPC to the daemon; starts it when needed. */
  request(method: string, params?: unknown): Promise<IpcResponse>;
  cwd(): string;
  /** Session id computed from the cwd config; throws `CliError` without config. */
  configSessionId(): string | Promise<string>;
  /** User argv as typed (without the binary), for the `next:` hint. */
  argv: string[];
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Root-level `-s` hoisted before the `sentra` group. */
  sessionArg?: string;
  /** Streaming for `live`; omitted where streaming is unsupported. */
  live?: LiveDeps;
}

interface SentraFlags {
  session?: string;
  from?: string;
  to?: string;
  since?: string;
  service?: string[];
  level?: string[];
  minLevel?: string;
  kind?: string;
  query?: string;
  release?: string;
  environment?: string;
  traceId?: string;
  limit?: string;
  skip?: string;
  json?: boolean;
  failIfAny?: boolean;
  before?: string;
}

type SentraCommandName = "errors" | "issues" | "show" | "clear" | "live";

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function parseLevel(value: string, flag: string): z.infer<typeof levelSchema> {
  const parsed = levelSchema.safeParse(value);
  if (!parsed.success) {
    throw new SentraUsageError(`Invalid --${flag} "${value}". Use one of: ${LEVEL_LIST}.`);
  }
  return parsed.data;
}

function parseKinds(value: string | undefined): z.infer<typeof itemKindSchema>[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const parsed = itemKindSchema.safeParse(part);
      if (!parsed.success) {
        throw new SentraUsageError(`Invalid --kind "${part}". Use one of: ${KIND_LIST}.`);
      }
      return parsed.data;
    });
}

function parseInteger(value: string | undefined, flag: string, min: number, max: number) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `from ${min} to ${max}`;
    throw new SentraUsageError(`Invalid --${flag} "${value}". Use an integer ${range}.`);
  }
  return parsed;
}

function timeWindow(flags: SentraFlags) {
  try {
    return resolveTimeWindow(flags);
  } catch (error) {
    throw new SentraUsageError(error instanceof Error ? error.message : String(error));
  }
}

function paging(flags: SentraFlags) {
  return {
    limit: parseInteger(flags.limit, "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT,
    skip: parseInteger(flags.skip, "skip", 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

function errorsFilters(flags: SentraFlags): Omit<ErrorsParams, "sessionId"> {
  return {
    service: nonEmpty(flags.service),
    kind: nonEmpty(parseKinds(flags.kind)),
    level: nonEmpty(flags.level?.map((value) => parseLevel(value, "level"))),
    minLevel: flags.minLevel === undefined ? undefined : parseLevel(flags.minLevel, "min-level"),
    q: flags.query,
    release: flags.release,
    environment: flags.environment,
    traceId: flags.traceId,
    ...timeWindow(flags),
    ...paging(flags),
  };
}

function issuesFilters(flags: SentraFlags): Omit<IssuesParams, "sessionId"> {
  return {
    service: nonEmpty(flags.service),
    level: nonEmpty(flags.level?.map((value) => parseLevel(value, "level"))),
    minLevel: flags.minLevel === undefined ? undefined : parseLevel(flags.minLevel, "min-level"),
    q: flags.query,
    ...timeWindow(flags),
    ...paging(flags),
  };
}

function clearFilters(flags: SentraFlags): { service?: string[]; to?: string | number } {
  if (flags.before === undefined) {
    return { service: nonEmpty(flags.service) };
  }
  try {
    return { service: nonEmpty(flags.service), to: parseTimeInput(flags.before, "before") };
  } catch (error) {
    throw new SentraUsageError(error instanceof Error ? error.message : String(error));
  }
}

async function resolveSessionFor(
  deps: SentraCliDeps,
  sessionArg: string | undefined,
): Promise<string> {
  const res = await deps.request("session.list");
  if (res.error) {
    throw new CliError(`Error: ${res.error}`);
  }
  return await resolveSentraSessionId({
    sessions: res.result,
    sessionArg,
    cwd: deps.cwd(),
    configSessionId: async () => deps.configSessionId(),
  });
}

function isJson(flags: SentraFlags, deps: SentraCliDeps): boolean {
  return flags.json === true || deps.env.ZAPS_FORMAT === "json";
}

function writeJson(deps: SentraCliDeps, data: unknown): void {
  deps.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

async function call(
  deps: SentraCliDeps,
  method: string,
  params: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; code: number }> {
  const res = await deps.request(method, params);
  if (res.error) {
    const { message, code } = describeSentraError(res.error);
    deps.stderr(`Error: ${message}\n`);
    return { ok: false, code };
  }
  return { ok: true, result: res.result };
}

async function runErrors(deps: SentraCliDeps, flags: SentraFlags): Promise<number> {
  const filters = errorsFilters(flags);
  const sessionId = await resolveSessionFor(deps, flags.session ?? deps.sessionArg);
  const res = await call(deps, "sentra.errors", { sessionId, ...filters });
  if (!res.ok) {
    return res.code;
  }
  const result = errorsResultSchema.parse(res.result);
  if (isJson(flags, deps)) {
    writeJson(deps, result);
  } else {
    const next = result.hasMore
      ? buildNextCommand(deps.argv, filters.skip ?? 0, filters.limit ?? DEFAULT_LIMIT)
      : null;
    deps.stdout(`${renderErrors(result, next)}\n`);
  }
  return flags.failIfAny === true && result.errors.length > 0 ? 1 : 0;
}

async function runIssues(deps: SentraCliDeps, flags: SentraFlags): Promise<number> {
  const filters = issuesFilters(flags);
  const sessionId = await resolveSessionFor(deps, flags.session ?? deps.sessionArg);
  const res = await call(deps, "sentra.issues", { sessionId, ...filters });
  if (!res.ok) {
    return res.code;
  }
  const result = issuesResultSchema.parse(res.result);
  if (isJson(flags, deps)) {
    writeJson(deps, result);
  } else {
    const next = result.hasMore
      ? buildNextCommand(deps.argv, filters.skip ?? 0, filters.limit ?? DEFAULT_LIMIT)
      : null;
    deps.stdout(`${renderIssues(result, next)}\n`);
  }
  return 0;
}

async function runShow(
  deps: SentraCliDeps,
  flags: SentraFlags,
  id: string | undefined,
): Promise<number> {
  if (id === undefined || id === "") {
    throw new SentraUsageError("Missing <id>. Usage: zaps sentra show <id>");
  }
  const sessionId = await resolveSessionFor(deps, flags.session ?? deps.sessionArg);
  const res = await call(deps, "sentra.show", { sessionId, id });
  if (!res.ok) {
    return res.code;
  }
  const result = showResultSchema.parse(res.result);
  if (isJson(flags, deps)) {
    writeJson(
      deps,
      result.type === "item"
        ? { type: result.type, item: result.item }
        : { type: result.type, issue: result.issue },
    );
  } else {
    const markdown = renderShow(result);
    deps.stdout(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }
  return 0;
}

async function runClear(deps: SentraCliDeps, flags: SentraFlags): Promise<number> {
  const filters = clearFilters(flags);
  const sessionId = await resolveSessionFor(deps, flags.session ?? deps.sessionArg);
  const res = await call(deps, "sentra.clear", { sessionId, ...filters });
  if (!res.ok) {
    return res.code;
  }
  const result = clearResultSchema.parse(res.result);
  if (isJson(flags, deps)) {
    writeJson(deps, result);
  } else {
    deps.stdout(`Cleared ${result.itemsDeleted} records.\n`);
  }
  return 0;
}

async function runLiveCommand(deps: SentraCliDeps, flags: SentraFlags): Promise<number> {
  const filter = {
    service: nonEmpty(flags.service),
    kind: nonEmpty(parseKinds(flags.kind)),
    level: nonEmpty(flags.level?.map((value) => parseLevel(value, "level"))),
    minLevel: flags.minLevel === undefined ? undefined : parseLevel(flags.minLevel, "min-level"),
    q: flags.query,
  };
  if (!deps.live) {
    deps.stderr("Error: live streaming is not available here.\n");
    return 1;
  }
  return runLive(
    {
      cwd: () => deps.cwd(),
      configSessionId: async () => deps.configSessionId(),
      stdout: (text) => deps.stdout(text),
      stderr: (text) => deps.stderr(text),
      sessionArg: flags.session ?? deps.sessionArg,
      json: isJson(flags, deps),
      live: deps.live,
    },
    filter,
  );
}

/** Runs one subcommand; returns the exit code. Usage errors → 2, runtime errors → 1. */
async function runSentraCommand(
  name: SentraCommandName,
  flags: SentraFlags,
  deps: SentraCliDeps,
  id?: string,
): Promise<number> {
  try {
    if (name === "errors") {
      return await runErrors(deps, flags);
    }
    if (name === "issues") {
      return await runIssues(deps, flags);
    }
    if (name === "show") {
      return await runShow(deps, flags, id);
    }
    if (name === "live") {
      return await runLiveCommand(deps, flags);
    }
    return await runClear(deps, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SentraUsageError) {
      deps.stderr(`Error: ${message}\n`);
      return 2;
    }
    deps.stderr(message.startsWith("Error: ") ? `${message}\n` : `Error: ${message}\n`);
    return 1;
  }
}

const sessionFlag = {
  session: {
    type: String,
    alias: "s",
    placeholder: "<id|name>",
    description: "Target session (default: session of the cwd)",
  },
};

const jsonFlag = { json: { type: Boolean, description: "Output as JSON" } };

const timeFlags = {
  from: {
    type: String,
    placeholder: "<time>",
    description: "From time (ISO 8601, epoch ms, or duration like 10m)",
  },
  to: {
    type: String,
    placeholder: "<time>",
    description: "To time (ISO 8601, epoch ms, or duration)",
  },
  since: { type: String, placeholder: "<duration>", description: "Relative --from, e.g. 30m" },
};

const levelFlags = {
  level: { type: [String] as const, placeholder: "<lvl>", description: "Exact level (repeatable)" },
  minLevel: { type: String, placeholder: "<lvl>", description: "Minimum level" },
};

const serviceFlag = {
  service: { type: [String] as const, placeholder: "<name>", description: "Service (repeatable)" },
};

const pagingFlags = {
  limit: {
    type: String,
    placeholder: "<n>",
    description: `Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
  },
  skip: { type: String, placeholder: "<n>", description: "Rows to skip (default 0)" },
};

const qFlag = {
  query: {
    type: String,
    alias: "q",
    placeholder: "<text>",
    description: "Title substring, case-insensitive (also --q)",
  },
};

function sentraCommands(deps: SentraCliDeps, settle: (pending: Promise<number>) => void) {
  return [
    command(
      {
        name: "errors",
        flags: {
          ...sessionFlag,
          ...timeFlags,
          ...serviceFlag,
          ...levelFlags,
          kind: {
            type: String,
            placeholder: "<k[,k]>",
            description: "Kinds (default error,message)",
          },
          ...qFlag,
          release: { type: String, placeholder: "<r>", description: "Release" },
          environment: { type: String, placeholder: "<e>", description: "Environment" },
          traceId: { type: String, placeholder: "<id>", description: "Trace id" },
          ...pagingFlags,
          ...jsonFlag,
          failIfAny: { type: Boolean, description: "Exit 1 when any error matches" },
        },
        help: { description: "List error events, newest first" },
      },
      (parsed) => {
        settle(runSentraCommand("errors", parsed.flags, deps));
      },
    ),
    command(
      {
        name: "issues",
        flags: {
          ...sessionFlag,
          ...timeFlags,
          ...serviceFlag,
          ...levelFlags,
          ...qFlag,
          ...pagingFlags,
          ...jsonFlag,
        },
        help: { description: "List grouped issues, last seen first" },
      },
      (parsed) => {
        settle(runSentraCommand("issues", parsed.flags, deps));
      },
    ),
    command(
      {
        name: "show",
        parameters: ["[id]"],
        flags: { ...sessionFlag, ...jsonFlag },
        help: { description: "Show a record, issue, or Sentry event id" },
      },
      (parsed) => {
        settle(runSentraCommand("show", parsed.flags, deps, parsed._.id));
      },
    ),
    command(
      {
        name: "clear",
        flags: {
          ...sessionFlag,
          ...serviceFlag,
          before: {
            type: String,
            placeholder: "<time>",
            description: "Only records received before this time",
          },
          ...jsonFlag,
        },
        help: { description: "Delete records of the session" },
      },
      (parsed) => {
        settle(runSentraCommand("clear", parsed.flags, deps));
      },
    ),
    command(
      {
        name: "live",
        flags: {
          ...sessionFlag,
          ...serviceFlag,
          ...levelFlags,
          kind: {
            type: String,
            placeholder: "<k[,k]>",
            description: "Kinds (default error,message with --min-level warning)",
          },
          ...qFlag,
          ...jsonFlag,
        },
        help: { description: "Stream new records until Ctrl-C (needs a running session)" },
      },
      (parsed) => {
        settle(runSentraCommand("live", parsed.flags, deps));
      },
    ),
  ];
}

interface AutoStartDeps {
  request(sock: string, method: string, params?: unknown): Promise<IpcResponse>;
  socket(): string;
  /** Starts the daemon; resolves with its socket. */
  ensureDaemon(): Promise<string>;
}

/** IPC that starts the daemon and retries once when it is not running. */
function createAutoStartRequest(deps: AutoStartDeps): SentraCliDeps["request"] {
  return async (method, params) => {
    try {
      return await deps.request(deps.socket(), method, params);
    } catch (error) {
      if (!(error instanceof CliError) || error.message !== DAEMON_NOT_RUNNING) {
        throw error;
      }
      return deps.request(await deps.ensureDaemon(), method, params);
    }
  };
}

/** Type-flag only accepts one-letter names as `-x`; the spec spells `--q`. */
function normalizeArgv(argv: string[]): string[] {
  return argv.map((arg) => {
    if (arg === "--q") {
      return "--query";
    }
    return arg.startsWith("--q=") ? `--query=${arg.slice("--q=".length)}` : arg;
  });
}

/** `zaps sentra <cmd>`; resolves with the exit code. */
async function runSentraCli(argv: string[], deps: SentraCliDeps): Promise<number> {
  let pending: Promise<number> | null = null;
  void cli(
    {
      name: "zaps sentra",
      commands: sentraCommands(deps, (promise) => {
        pending = promise;
      }),
      flags: { ...sessionFlag },
      help: { description: "Runtime errors collected from Sentry SDKs" },
      strictFlags: true,
    },
    (parsed) => {
      const [unknownCommand] = parsed._;
      if (unknownCommand !== undefined) {
        deps.stderr(`error: unknown command '${unknownCommand}'\n`);
        pending = Promise.resolve(1);
        return;
      }
      parsed.showHelp();
      pending = Promise.resolve(1);
    },
    normalizeArgv(argv),
  );
  return pending ?? Promise.resolve(1);
}

export { createAutoStartRequest, resolveSessionFor, runSentraCli, runSentraCommand };
export type { AutoStartDeps, SentraCliDeps, SentraFlags };
