/* eslint-disable class-methods-use-this -- Mock classes mimic SDK interface */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- IPC mocks (same pattern as daemon-client tests) ---

const mockIpcRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcStream = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcSubscribe = vi.fn();

vi.mock("../../src/lib/ipc/client.js", () => ({
  ipcRequest: async (...args: unknown[]) => mockIpcRequest(...args),
  ipcStream: async (...args: unknown[]) => mockIpcStream(...args),
  ipcSubscribe: (...args: unknown[]) => mockIpcSubscribe(...args),
}));

// --- MCP SDK mocks ---

type ToolCb = (args: Record<string, unknown>) => Promise<unknown>;
type ResourceReadCb = (
  uri: { href: string },
  variables: Record<string, unknown>,
) => Promise<unknown>;
interface TemplateConfig {
  list: () => Promise<unknown>;
}

const registeredTools = new Map<string, { meta: unknown; cb: ToolCb }>();
const registeredResources = new Map<
  string,
  { template: { pattern: string; config: TemplateConfig }; meta: unknown; cb: ResourceReadCb }
>();

const mockSendResourceUpdated = vi.fn();
const mockConnect = vi.fn();
let mcpServerCtorArgs: unknown[] = [];

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    server = { sendResourceUpdated: mockSendResourceUpdated };

    constructor(...args: unknown[]) {
      mcpServerCtorArgs = args;
    }

    registerTool(name: string, meta: unknown, handler: ToolCb) {
      registeredTools.set(name, { meta, cb: handler });
    }

    registerResource(
      name: string,
      template: { pattern: string; config: TemplateConfig },
      meta: unknown,
      handler: ResourceReadCb,
    ) {
      registeredResources.set(name, { template, meta, cb: handler });
    }

    async connect(...args: unknown[]) {
      mockConnect(...args);
    }
  }

  class MockResourceTemplate {
    pattern: string;
    config: TemplateConfig;

    constructor(pattern: string, config: TemplateConfig) {
      this.pattern = pattern;
      this.config = config;
    }
  }

  return { McpServer: MockMcpServer, ResourceTemplate: MockResourceTemplate };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// --- Import under test ---

const { startMcpServer } = await import("../../src/mcp/server.js");

const SOCK = "/test.sock";
const SESSION = "sess1";

describe("startMcpServer", () => {
  beforeEach(async () => {
    mockIpcRequest.mockReset();
    mockIpcStream.mockReset();
    mockIpcSubscribe.mockReset();
    mockConnect.mockClear();
    mockSendResourceUpdated.mockClear();
    mcpServerCtorArgs = [];
    registeredTools.clear();
    registeredResources.clear();
    await startMcpServer(SOCK, SESSION);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Setup ---

  describe("setup", () => {
    it("creates McpServer with correct name/version/capabilities", () => {
      expect(mcpServerCtorArgs).toEqual([
        { name: "zaps", version: "0.1.0" },
        { capabilities: { resources: { subscribe: true, listChanged: true } } },
      ]);
    });

    it("registers all 11 tools", () => {
      expect(registeredTools.size).toBe(11);
      const expected = [
        "services_list",
        "services_details",
        "services_start",
        "services_stop",
        "services_restart",
        "services_start_all",
        "services_stop_all",
        "services_restart_all",
        "logs_snapshot",
        "tasks_list",
        "tasks_run",
      ];
      for (const name of expected) {
        expect(registeredTools.has(name)).toBe(true);
      }
    });

    it("connects StdioServerTransport", () => {
      expect(mockConnect).toHaveBeenCalledOnce();
    });
  });

  // --- Read-only tool forwarding ---

  describe("read-only tools", () => {
    it("services_list forwards to ipcRequest and returns JSON", async () => {
      const statuses = [{ name: "api", state: "ready" }];
      mockIpcRequest.mockResolvedValue({ id: "r1", result: statuses });

      const result = await registeredTools.get("services_list")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.list",
        undefined,
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }],
      });
    });

    it("services_details forwards { name } param", async () => {
      const details = { name: "api", state: "ready", pid: 123 };
      mockIpcRequest.mockResolvedValue({ id: "r1", result: details });

      const result = await registeredTools.get("services_details")!.cb({ name: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.details",
        { name: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
      });
    });

    it("logs_snapshot forwards { service } and joins lines", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: ["line1", "line2", "line3"] });

      const result = await registeredTools.get("logs_snapshot")!.cb({ service: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "logs.snapshot",
        { service: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: "line1\nline2\nline3" }],
      });
    });

    it("tasks_list forwards to ipcRequest", async () => {
      const tasks = [{ key: "build", name: "Build" }];
      mockIpcRequest.mockResolvedValue({ id: "r1", result: tasks });

      const result = await registeredTools.get("tasks_list")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(SOCK, "tasks.list", undefined, 30_000, SESSION);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      });
    });

    it("tool throws on IPC error response", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Not found" });

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow("Not found");
    });
  });

  // --- Mutation tool forwarding ---

  describe("mutation tools", () => {
    it("services_start forwards { name } and returns JSON", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { started: "api" } });

      const result = await registeredTools.get("services_start")!.cb({ name: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.start",
        { name: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: "api" }) }],
      });
    });

    it("services_stop forwards { name }", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { stopped: "api" } });

      const result = await registeredTools.get("services_stop")!.cb({ name: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.stop",
        { name: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ stopped: "api" }) }],
      });
    });

    it("services_restart forwards { name }", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: "api" } });

      const result = await registeredTools.get("services_restart")!.cb({ name: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.restart",
        { name: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ restarted: "api" }) }],
      });
    });
  });

  // --- Batch mutation tools ---

  describe("batch mutation tools", () => {
    it("services_start_all forwards without params when names omitted", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { started: ["api", "web"] } });

      const result = await registeredTools.get("services_start_all")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.startAll",
        undefined,
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: ["api", "web"] }) }],
      });
    });

    it("services_start_all forwards { names } when provided", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { started: ["api"] } });

      const result = await registeredTools.get("services_start_all")!.cb({ names: ["api"] });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.startAll",
        { names: ["api"] },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ started: ["api"] }) }],
      });
    });

    it("services_start_all throws on IPC error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Daemon unavailable" });

      await expect(registeredTools.get("services_start_all")!.cb({})).rejects.toThrow(
        "Daemon unavailable",
      );
    });

    it("services_stop_all forwards without params when names omitted", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { stopped: ["api", "web"] } });

      const result = await registeredTools.get("services_stop_all")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.stopAll",
        undefined,
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ stopped: ["api", "web"] }) }],
      });
    });

    it("services_stop_all forwards { names } when provided", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { stopped: ["web"] } });

      const result = await registeredTools.get("services_stop_all")!.cb({ names: ["web"] });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.stopAll",
        { names: ["web"] },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ stopped: ["web"] }) }],
      });
    });

    it("services_stop_all has destructiveHint annotation", () => {
      const meta = registeredTools.get("services_stop_all")!.meta as {
        annotations?: { destructiveHint?: boolean };
      };
      expect(meta.annotations?.destructiveHint).toBe(true);
    });

    it("services_restart_all forwards without params when names omitted", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: ["api", "web"] } });

      const result = await registeredTools.get("services_restart_all")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.restartAll",
        undefined,
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ restarted: ["api", "web"] }) }],
      });
    });

    it("services_restart_all forwards { names } when provided", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: ["api"] } });

      const result = await registeredTools.get("services_restart_all")!.cb({ names: ["api"] });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "services.restartAll",
        { names: ["api"] },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ restarted: ["api"] }) }],
      });
    });

    it("services_restart_all throws on IPC error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Timeout" });

      await expect(registeredTools.get("services_restart_all")!.cb({})).rejects.toThrow("Timeout");
    });
  });

  // --- tasks_run streaming ---

  describe("tasks_run", () => {
    it("collects line events and returns joined output", async () => {
      mockIpcStream.mockImplementation(
        async (_sock: unknown, _method: unknown, _params: unknown, onEvent: unknown) => {
          const emit = onEvent as (event: string, data: unknown) => void;
          emit("line", "output1");
          emit("line", "output2");
          return { id: "r1", result: { success: true } };
        },
      );

      const result = await registeredTools.get("tasks_run")!.cb({ key: "build" });

      expect(mockIpcStream).toHaveBeenCalledWith(
        SOCK,
        "tasks.run",
        { key: "build" },
        expect.any(Function),
        120_000,
        SESSION,
      );
      expect(result).toEqual({
        content: [{ type: "text", text: "output1\noutput2" }],
        isError: false,
      });
    });

    it("returns isError: true on IPC error", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", error: "task failed" });

      const result = await registeredTools.get("tasks_run")!.cb({ key: "bad" });

      expect(result).toEqual({
        content: [{ type: "text", text: "Error: task failed" }],
        isError: true,
      });
    });

    it("returns fallback text on success with no output", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", result: { success: true } });

      const result = await registeredTools.get("tasks_run")!.cb({ key: "empty" });

      expect(result).toEqual({
        content: [{ type: "text", text: "Task completed." }],
        isError: false,
      });
    });

    it("returns fallback failure text on failure with no output", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", result: { success: false } });

      const result = await registeredTools.get("tasks_run")!.cb({ key: "fail" });

      expect(result).toEqual({
        content: [{ type: "text", text: "Task failed." }],
        isError: true,
      });
    });
  });

  // --- Resources ---

  describe("resources", () => {
    it("list callback returns URI per service", async () => {
      const statuses = [
        { name: "api", state: "ready" },
        { name: "web", state: "stopped" },
      ];
      mockIpcRequest.mockResolvedValue({ id: "r1", result: statuses });

      const resource = registeredResources.get("service-logs")!;
      const result = await resource.template.config.list();

      expect(result).toEqual({
        resources: [
          {
            uri: "zaps://logs/api",
            name: "api logs",
            description: "Log output for api",
            mimeType: "text/plain",
          },
          {
            uri: "zaps://logs/web",
            name: "web logs",
            description: "Log output for web",
            mimeType: "text/plain",
          },
        ],
      });
    });

    it("read callback returns log text content", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: ["log1", "log2"] });

      const resource = registeredResources.get("service-logs")!;
      const result = await resource.cb({ href: "zaps://logs/api" }, { serviceName: "api" });

      expect(mockIpcRequest).toHaveBeenCalledWith(
        SOCK,
        "logs.snapshot",
        { service: "api" },
        30_000,
        SESSION,
      );
      expect(result).toEqual({
        contents: [{ uri: "zaps://logs/api", text: "log1\nlog2", mimeType: "text/plain" }],
      });
    });

    it("ipcSubscribe log.lines event triggers sendResourceUpdated", () => {
      expect(mockIpcSubscribe).toHaveBeenCalledWith(
        SOCK,
        SESSION,
        ["log.lines"],
        expect.any(Function),
      );

      const eventHandler = mockIpcSubscribe.mock.calls[0][3] as (event: unknown) => void;
      eventHandler({ event: "log.lines", data: { service: "api" } });

      expect(mockSendResourceUpdated).toHaveBeenCalledWith({ uri: "zaps://logs/api" });
    });

    it("ipcSubscribe ignores non-log.lines events", () => {
      const eventHandler = mockIpcSubscribe.mock.calls[0][3] as (event: unknown) => void;
      eventHandler({ event: "service.stateChange", data: { name: "api" } });

      expect(mockSendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  // --- Error propagation ---

  describe("error propagation", () => {
    it("request() catches ECONNREFUSED and returns friendly message", async () => {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      mockIpcRequest.mockRejectedValue(err);

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
      );
    });

    it("request() catches ENOENT and returns friendly message", async () => {
      const err = new Error("connect ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockIpcRequest.mockRejectedValue(err);

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
      );
    });

    it("request() re-throws unknown errors", async () => {
      mockIpcRequest.mockRejectedValue(new Error("unexpected"));

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow("unexpected");
    });

    it("request() helper throws on IPC error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Session expired" });

      await expect(registeredTools.get("services_details")!.cb({ name: "api" })).rejects.toThrow(
        "Session expired",
      );
    });

    it("tasks_run stream error returns isError: true", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", error: "Stream broke" });

      const result = await registeredTools.get("tasks_run")!.cb({ key: "x" });

      expect(result).toEqual({
        content: [{ type: "text", text: "Error: Stream broke" }],
        isError: true,
      });
    });
  });
});
