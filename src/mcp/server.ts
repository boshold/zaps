/* eslint-disable no-unsafe-type-assertion -- IPC boundary */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { SessionInfo } from "#src/cli/helpers.js";
import {
  CliError,
  findSessionByDir,
  resolveSessionId,
  resolveTargetSession,
} from "#src/cli/helpers.js";
import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { renderErrors, renderIssues, renderShow } from "#src/lib/sentra/render.js";
import {
  MAX_LIMIT,
  errorsResultSchema,
  issuesResultSchema,
  itemKindSchema,
  levelSchema,
  showResultSchema,
} from "#src/lib/sentra/schemas.js";
import { describeSentraError, resolveSentraSessionId } from "#src/lib/sentra/session-id.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

function classifyDaemonError(error: unknown): Error {
  const { code } = error as NodeJS.ErrnoException;
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return new Error("Daemon not running. Start with `zaps up` or `zaps daemon start`.", {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

const TIME_WINDOW_HINT =
  "Use `from` = ISO timestamp taken before reproducing/testing. Then only errors of that run show up.";

const sentraTimeShape = {
  from: z
    .string()
    .optional()
    .describe("Start: ISO 8601, epoch ms, or duration like 10m (now minus)"),
  to: z.string().optional().describe("End: ISO 8601, epoch ms, or duration"),
  since: z.string().optional().describe("Relative start, e.g. 10m (not with from)"),
};

const sentraPageShape = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Max rows (default 20)"),
  skip: z.number().int().min(0).optional().describe("Rows to skip (default 0)"),
};

function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError }
    : { content: [{ type: "text", text }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startMcpServer(socketPath: string, sessionArg?: string): Promise<void> {
  const server = new McpServer(
    { name: "zaps", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true, listChanged: true } } },
  );

  /**
   * Resolve the session binding fresh on every call (E9) — never cached, so a
   * server started before `zaps up` (or surviving `zaps down && zaps up`) picks
   * up the current session on the next tool call. An explicit `-s` override is
   * matched verbatim (bad/ambiguous arg surfaces the CLI error); otherwise the
   * cwd is matched against `session.list` exactly as the CLI does.
   */
  async function resolveSession(): Promise<string> {
    let listRes: Awaited<ReturnType<typeof ipcRequest>> | undefined = undefined;
    try {
      listRes = await ipcRequest(socketPath, "session.list", undefined, 30_000);
    } catch (error) {
      throw classifyDaemonError(error);
    }
    if (listRes.error) {
      throw new Error(listRes.error);
    }
    const sessions = listRes.result as SessionInfo[];
    if (sessionArg) {
      try {
        return resolveTargetSession(sessions, sessionArg).id;
      } catch (error) {
        throw error instanceof CliError ? new Error(error.message) : error;
      }
    }
    const dir = process.cwd();
    const match = findSessionByDir(sessions, dir);
    if (!match) {
      throw new Error(`No running zaps session for ${dir}. Run 'zaps up' first.`);
    }
    return match.id;
  }

  async function request(method: string, params?: unknown): Promise<unknown> {
    const sessionId = await resolveSession();
    let res: Awaited<ReturnType<typeof ipcRequest>> | undefined = undefined;
    try {
      res = await ipcRequest(socketPath, method, params, 30_000, sessionId);
    } catch (error) {
      throw classifyDaemonError(error);
    }
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result;
  }

  /** Running session, `-s` verbatim, or the cwd config id (stopped session). */
  async function resolveSentraSession(): Promise<string> {
    let listRes: Awaited<ReturnType<typeof ipcRequest>> | undefined = undefined;
    try {
      listRes = await ipcRequest(socketPath, "session.list", undefined, 30_000);
    } catch (error) {
      throw classifyDaemonError(error);
    }
    if (listRes.error) {
      throw new Error(listRes.error);
    }
    return resolveSentraSessionId({
      sessions: listRes.result,
      sessionArg,
      cwd: process.cwd(),
      configSessionId: () => resolveSessionId().id,
    });
  }

  /** Daemon-level `sentra.*` call; errors become `isError` results with CLI messages. */
  async function sentraTool(
    method: string,
    params: Record<string, unknown>,
    render: (result: unknown) => string,
  ): Promise<CallToolResult> {
    try {
      const sessionId = await resolveSentraSession();
      let res: Awaited<ReturnType<typeof ipcRequest>> | undefined = undefined;
      try {
        res = await ipcRequest(socketPath, method, { ...params, sessionId }, 30_000);
      } catch (error) {
        throw classifyDaemonError(error);
      }
      if (res.error) {
        return textResult(describeSentraError(res.error).message, true);
      }
      return textResult(render(res.result));
    } catch (error) {
      return textResult(errorMessage(error), true);
    }
  }

  // --- Tools ---

  server.registerTool(
    "services_list",
    {
      description: "List all services and their statuses",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await request("services.list"), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "services_details",
    {
      description: "Get details for a specific service",
      inputSchema: { name: z.string().describe("Service name") },
      annotations: { readOnlyHint: true },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await request("services.details", { name: args.name }), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "services_start",
    {
      description: "Start a service",
      inputSchema: { name: z.string().describe("Service name") },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await request("services.start", { name: args.name })),
        },
      ],
    }),
  );

  server.registerTool(
    "services_stop",
    {
      description: "Stop a service",
      inputSchema: { name: z.string().describe("Service name") },
      annotations: { destructiveHint: true },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await request("services.stop", { name: args.name })),
        },
      ],
    }),
  );

  server.registerTool(
    "services_restart",
    {
      description: "Restart a service",
      inputSchema: { name: z.string().describe("Service name") },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await request("services.restart", { name: args.name })),
        },
      ],
    }),
  );

  server.registerTool(
    "services_start_all",
    {
      description: "Start all services, or specific ones by name",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Service names (omit for all)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await request("services.startAll", args.names ? { names: args.names } : undefined),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "services_stop_all",
    {
      description: "Stop all services, or specific ones by name",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Service names (omit for all)"),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await request("services.stopAll", args.names ? { names: args.names } : undefined),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "services_restart_all",
    {
      description: "Restart all services, or specific ones by name",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Service names (omit for all)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await request("services.restartAll", args.names ? { names: args.names } : undefined),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "logs_snapshot",
    {
      description: "Get recent log lines for a service",
      inputSchema: { service: z.string().describe("Service name") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const lines = (await request("logs.snapshot", { service: args.service })) as string[];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "tasks_list",
    {
      description: "List available tasks",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await request("tasks.list"), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "tasks_run",
    {
      description: "Run a task and return its output",
      inputSchema: { key: z.string().describe("Task key") },
    },
    async (args) => {
      const sessionId = await resolveSession();
      const lines: string[] = [];
      // Inactivity-based timeout (E3, P05-T04): the 120s window resets on every
      // Line/progress event, so a long task that keeps emitting completes.
      const res = await ipcStream(
        socketPath,
        "tasks.run",
        { key: args.key },
        (event, data) => {
          if (event === "line") {
            lines.push(data as string);
          }
        },
        120_000,
        sessionId,
      );
      if (res.error) {
        return { content: [{ type: "text" as const, text: `Error: ${res.error}` }], isError: true };
      }
      const result = res.result as { success: boolean };
      const output = lines.join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: output || (result.success ? "Task completed." : "Task failed."),
          },
        ],
        isError: !result.success,
      };
    },
  );

  server.registerTool(
    "sentra_errors",
    {
      description: `List runtime error events (Sentry SDKs) of this project's session, newest first. TOON rows: id, receivedAt, service, kind, level, title, location, issueId; plus hasMore. Defaults: kind error,message and min level error (level default dropped when kind/level/minLevel given). ${TIME_WINDOW_HINT} Page with skip.`,
      inputSchema: {
        service: z.array(z.string()).min(1).optional().describe("Services"),
        ...sentraTimeShape,
        level: z.array(levelSchema).min(1).optional().describe("Exact levels"),
        minLevel: levelSchema.optional().describe("Minimum level"),
        kind: z.array(itemKindSchema).min(1).optional().describe("Record kinds"),
        q: z.string().optional().describe("Case-insensitive title substring"),
        ...sentraPageShape,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      sentraTool("sentra.errors", args, (result) => {
        const parsed = errorsResultSchema.parse(result);
        return `${renderErrors(parsed, null)}\nhasMore: ${parsed.hasMore}`;
      }),
  );

  server.registerTool(
    "sentra_issues",
    {
      description: `List grouped runtime errors (issues) of this project's session, last seen first; time filters apply to lastSeen. TOON rows: id, shortId, services, level, title, culprit, count, firstSeen, lastSeen; plus hasMore. ${TIME_WINDOW_HINT}`,
      inputSchema: {
        service: z.array(z.string()).min(1).optional().describe("Services"),
        ...sentraTimeShape,
        minLevel: levelSchema.optional().describe("Minimum level"),
        q: z.string().optional().describe("Case-insensitive title substring"),
        ...sentraPageShape,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      sentraTool("sentra.issues", args, (result) => {
        const parsed = issuesResultSchema.parse(result);
        return `${renderIssues(parsed, null)}\nhasMore: ${parsed.hasMore}`;
      }),
  );

  server.registerTool(
    "sentra_show",
    {
      description:
        "Show one runtime error record, issue, or Sentry event id (32 hex) as Markdown: title, level, service, mapped stack with source context, breadcrumbs, request, tags.",
      inputSchema: { id: z.string().min(1).describe("Record id, issue id, or event id") },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      sentraTool("sentra.show", args, (result) => renderShow(showResultSchema.parse(result))),
  );

  // --- Resources: live log streaming ---

  server.registerResource(
    "service-logs",
    new ResourceTemplate("zaps://logs/{serviceName}", {
      list: async () => {
        const statuses = (await request("services.list")) as ServiceStatus[];
        return {
          resources: statuses.map((s) => ({
            uri: `zaps://logs/${s.name}`,
            name: `${s.name} logs`,
            description: `Log output for ${s.name}`,
            mimeType: "text/plain",
          })),
        };
      },
    }),
    { description: "Live log output for a service", mimeType: "text/plain" },
    async (uri, variables) => {
      const serviceName = variables.serviceName as string;
      const lines = (await request("logs.snapshot", { service: serviceName })) as string[];
      return {
        contents: [{ uri: uri.href, text: lines.join("\n"), mimeType: "text/plain" }],
      };
    },
  );

  // Subscribe to daemon log events → push resource update notifications.
  // Best-effort: bound to whichever session resolves at startup. Tool calls
  // Re-resolve per call regardless; if no session exists yet, notifications are
  // Simply unavailable until the server is restarted.
  const subscriptionSessionId = await resolveSession().catch(() => "");
  if (subscriptionSessionId) {
    ipcSubscribe(socketPath, subscriptionSessionId, ["log.lines"], (event: DaemonEvent) => {
      if (event.event === "log.lines") {
        const data = event.data as { service: string };
        // eslint-disable-next-line no-void -- Fire-and-forget notification
        void server.server.sendResourceUpdated({ uri: `zaps://logs/${data.service}` });
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { startMcpServer };
