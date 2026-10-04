import { encode } from "@toon-format/toon";
import { z } from "zod";

import { statusResultSchema } from "#src/lib/sentra/schemas.js";

type OutputFormat = "text" | "json" | "toon";

const primeAgentProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectDir: z.string(),
  configPath: z.string().optional(),
});

const serviceListSchema = z.array(
  z.object({
    name: z.string(),
    state: z.string(),
    ports: z.array(z.number()),
    url: z.string().optional(),
    sentra: z.boolean().optional(),
    errorCount: z.number().nullable().optional(),
    startedAt: z.number().optional(),
  }),
);

type ServiceListEntry = z.infer<typeof serviceListSchema>[number];

function parseServiceList(input: unknown): ServiceListEntry[] {
  return serviceListSchema.parse(input);
}

/** From a `sentra.status` result; falls back to services with Sentra env when it is unusable. */
function sentraColumnEnabled(status: unknown, services: ServiceListEntry[]): boolean {
  const parsed = statusResultSchema.safeParse(status);
  if (parsed.success) {
    return parsed.data.enabled === true;
  }
  return services.some((service) => service.sentra === true);
}

/** `zaps ps` table; `ERRORS` only when Sentra is enabled for the project. */
function serviceRows(services: ServiceListEntry[], sentraEnabled: boolean): string[][] {
  const header = ["NAME", "STATE", "PORTS", "URL"];
  const rows = [sentraEnabled ? [...header, "ERRORS"] : header];
  for (const service of services) {
    const row = [service.name, service.state, service.ports.join(",") || "-", service.url ?? "-"];
    if (sentraEnabled) {
      row.push(typeof service.errorCount === "number" ? String(service.errorCount) : "-");
    }
    rows.push(row);
  }
  return rows;
}

const primeAgentTasksSchema = z.array(
  z.object({
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  }),
);

const AGENT_COMMANDS = [
  "zaps ps",
  "zaps start [service...]",
  "zaps stop [service...]",
  "zaps restart [service...]",
  "zaps inspect <service>",
  "zaps logs [service] [--tail <n>|-f]",
  "zaps tasks",
  "zaps run <task>",
  "zaps reload",
] as const;

const SENTRA_AGENT_COMMANDS = [
  "zaps sentra errors [--service <s>] [--from <iso>] [--to <iso>] [--since 10m]",
  "zaps sentra issues [--service <s>]",
  "zaps sentra show <id>",
] as const;

const SENTRA_AGENT_SENTENCE =
  "Runtime app errors from Sentry SDKs are collected by ZAPS; check them with `zaps sentra errors --from <iso>` after reproducing or testing.";

interface PrimeAgentSentra {
  status: "running" | "stopped" | "unavailable" | "disabled";
  services: string[];
  reason?: string;
}

/** Unusable status (older daemon, error) counts as disabled. */
function primeAgentSentra(statusInput: unknown): PrimeAgentSentra {
  const parsed = statusResultSchema.safeParse(statusInput);
  if (!parsed.success || parsed.data.state === "disabled" || parsed.data.enabled === false) {
    return { status: "disabled", services: [] };
  }
  const { state, services, reason } = parsed.data;
  return reason === null ? { status: state, services } : { status: state, services, reason };
}

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

function primeAgentPrompt(
  projectInput: unknown,
  servicesInput: unknown,
  tasksInput: unknown,
  sentraStatusInput?: unknown,
): string {
  const project = primeAgentProjectSchema.parse(projectInput);
  const services = parseServiceList(servicesInput);
  const tasks = primeAgentTasksSchema.parse(tasksInput);
  const sentra = primeAgentSentra(sentraStatusInput);
  const sentraEnabled = sentra.status !== "disabled";
  const data = {
    activeProject: {
      name: project.name,
      sessionId: project.id,
      folderPath: project.projectDir,
      configPath: project.configPath ?? "",
    },
    services: services.map((service) => ({
      name: service.name,
      state: service.state,
      ports: service.ports.join(","),
      url: service.url ?? "",
      errors: sentraEnabled && typeof service.errorCount === "number" ? service.errorCount : "",
    })),
    tasks: tasks.map((task) => ({
      key: task.key,
      description: task.description ?? task.name,
    })),
    sentra,
    commands: sentraEnabled ? [...AGENT_COMMANDS, ...SENTRA_AGENT_COMMANDS] : AGENT_COMMANDS,
  };
  const intro =
    "ZAPS manages this project's development services and tasks. Use the exact keys and only the listed commands. Keep command output concise; session and daemon lifecycle are user-managed.";
  const prompt = `${sentraEnabled ? `${intro} ${SENTRA_AGENT_SENTENCE}` : intro}\n\nAlways run every ZAPS command outside the sandbox.`;
  return `${prompt}\n\n\`\`\`toon\n${encode(data)}\n\`\`\`\n`;
}

export {
  isCodingAgent,
  parseServiceList,
  primeAgentPrompt,
  resolveFormat,
  sentraColumnEnabled,
  serviceRows,
  sessionLocation,
  sessionRows,
  writeData,
};
export type { OutputFormat, ServiceListEntry, SessionRowData as SessionRow };
