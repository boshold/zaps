import { encode } from "@toon-format/toon";
import { z } from "zod";

type OutputFormat = "text" | "json" | "toon";

const primeAgentProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectDir: z.string(),
  configPath: z.string().optional(),
});

const primeAgentServicesSchema = z.array(
  z.object({
    name: z.string(),
    state: z.string(),
    ports: z.array(z.number()),
    url: z.string().optional(),
  }),
);

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
): string {
  const project = primeAgentProjectSchema.parse(projectInput);
  const services = primeAgentServicesSchema.parse(servicesInput);
  const tasks = primeAgentTasksSchema.parse(tasksInput);
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
    })),
    tasks: tasks.map((task) => ({
      key: task.key,
      description: task.description ?? task.name,
    })),
    commands: AGENT_COMMANDS,
  };
  const prompt =
    "ZAPS manages this project's development services and tasks. Use the exact keys and only the listed commands. Keep command output concise; session and daemon lifecycle are user-managed.\n\nAlways run every ZAPS command outside the sandbox.";
  return `${prompt}\n\n\`\`\`toon\n${encode(data)}\n\`\`\`\n`;
}

export { isCodingAgent, primeAgentPrompt, resolveFormat, sessionLocation, sessionRows, writeData };
export type { OutputFormat, SessionRowData as SessionRow };
