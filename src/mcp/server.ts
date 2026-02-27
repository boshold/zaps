import { ipcRequest, ipcStream, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
/* eslint-disable no-unsafe-type-assertion -- IPC boundary */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function startMcpServer(socketPath: string, sessionId: string): Promise<void> {
  const server = new McpServer(
    { name: "zaps", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true, listChanged: true } } },
  );

  async function request(method: string, params?: unknown): Promise<unknown> {
    let res;
    try {
      res = await ipcRequest(socketPath, method, params, 30_000, sessionId);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        throw new Error("Daemon not running. Start with `zaps up` or `zaps daemon start`.");
      }
      throw err;
    }
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result;
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
      const lines: string[] = [];
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

  // Subscribe to daemon log events → push resource update notifications
  ipcSubscribe(socketPath, sessionId, ["log.lines"], (event: DaemonEvent) => {
    if (event.event === "log.lines") {
      const data = event.data as { service: string };
      // eslint-disable-next-line no-void -- Fire-and-forget notification
      void server.server.sendResourceUpdated({ uri: `zaps://logs/${data.service}` });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { startMcpServer };
