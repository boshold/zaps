/* eslint-disable class-methods-use-this -- Mock classes mimic SDK interface */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionId } from "../../src/daemon/session.js";

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
    public server = { sendResourceUpdated: mockSendResourceUpdated };

    public constructor(...args: unknown[]) {
      mcpServerCtorArgs = args;
    }

    public registerTool(name: string, meta: unknown, handler: ToolCb) {
      registeredTools.set(name, { meta, cb: handler });
    }

    public registerResource(
      name: string,
      template: { pattern: string; config: TemplateConfig },
      meta: unknown,
      handler: ResourceReadCb,
    ) {
      registeredResources.set(name, { template, meta, cb: handler });
    }

    public async connect(...args: unknown[]) {
      mockConnect(...args);
    }
  }

  class MockResourceTemplate {
    public pattern: string;
    public config: TemplateConfig;

    public constructor(pattern: string, config: TemplateConfig) {
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

// Every tool call re-resolves the session via `session.list` (E9); the mock routes `session.list` to the binding list and every other method to the per-test response, with the default binding mapping the test cwd to SESSION.
let listResponse: unknown;
let methodResponder: () => Promise<unknown>;

function setSessionList(result: unknown): void {
  listResponse = result;
}
function setMethodResult(result: unknown): void {
  methodResponder = async () => result;
}
function setMethodError(err: unknown): void {
  methodResponder = async () => {
    throw err;
  };
}

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

    listResponse = { id: "L", result: [{ id: SESSION, name: "proj", projectDir: process.cwd() }] };
    methodResponder = async () => ({ id: "r1", result: undefined });
    mockIpcRequest.mockImplementation(async (_sock: unknown, method: unknown) =>
      method === "session.list" ? listResponse : methodResponder(),
    );

    await startMcpServer(SOCK);
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

    it("registers all 14 tools", () => {
      expect(registeredTools.size).toBe(14);
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
        "sentra_errors",
        "sentra_issues",
        "sentra_show",
      ];
      for (const name of expected) {
        expect(registeredTools.has(name)).toBe(true);
      }
    });

    it("connects StdioServerTransport", () => {
      expect(mockConnect).toHaveBeenCalledOnce();
    });
  });

  // --- Per-call session resolution (E9) ---

  describe("per-call session resolution", () => {
    it("a tool call with no running session returns the exact actionable error", async () => {
      setSessionList({ id: "L", result: [] });
      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        `No running zaps session for ${process.cwd()}. Run 'zaps up' first.`,
      );
    });

    it("re-resolves the session id on every call (picks up a restart)", async () => {
      setMethodResult({ id: "r1", result: [] });

      setSessionList({
        id: "L",
        result: [{ id: "sess-A", name: "proj", projectDir: process.cwd() }],
      });
      await registeredTools.get("services_list")!.cb({});
      expect(mockIpcRequest).toHaveBeenLastCalledWith(
        SOCK,
        "services.list",
        undefined,
        30_000,
        "sess-A",
      );

      // Simulate `zaps down && zaps up` minting a new id for the same project.
      setSessionList({
        id: "L",
        result: [{ id: "sess-B", name: "proj", projectDir: process.cwd() }],
      });
      await registeredTools.get("services_list")!.cb({});
      expect(mockIpcRequest).toHaveBeenLastCalledWith(
        SOCK,
        "services.list",
        undefined,
        30_000,
        "sess-B",
      );
    });

    it("surfaces daemon-down (ENOENT) at resolution time", async () => {
      const err = new Error("connect ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockIpcRequest.mockImplementation(async () => {
        throw err;
      });
      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
      );
    });

    it("surfaces a bad -s override verbatim", async () => {
      registeredTools.clear();
      setSessionList({ id: "L", result: [{ id: "real", name: "proj", projectDir: "/p" }] });
      await startMcpServer(SOCK, "ghost");
      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Session not found: ghost",
      );
    });
  });

  // --- Read-only tool forwarding ---

  describe("read-only tools", () => {
    it("services_list forwards to ipcRequest and returns JSON", async () => {
      const statuses = [{ name: "api", state: "ready" }];
      setMethodResult({ id: "r1", result: statuses });

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
      setMethodResult({ id: "r1", result: details });

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
      setMethodResult({ id: "r1", result: ["line1", "line2", "line3"] });

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
      setMethodResult({ id: "r1", result: tasks });

      const result = await registeredTools.get("tasks_list")!.cb({});

      expect(mockIpcRequest).toHaveBeenCalledWith(SOCK, "tasks.list", undefined, 30_000, SESSION);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      });
    });

    it("tool throws on IPC error response", async () => {
      setMethodResult({ id: "r1", error: "Not found" });

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow("Not found");
    });
  });

  // --- Mutation tool forwarding ---

  describe("mutation tools", () => {
    it("services_start forwards { name } and returns JSON", async () => {
      setMethodResult({ id: "r1", result: { started: "api" } });

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
      setMethodResult({ id: "r1", result: { stopped: "api" } });

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
      setMethodResult({ id: "r1", result: { restarted: "api" } });

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
      setMethodResult({ id: "r1", result: { started: ["api", "web"] } });

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
      setMethodResult({ id: "r1", result: { started: ["api"] } });

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
      setMethodResult({ id: "r1", error: "Daemon unavailable" });

      await expect(registeredTools.get("services_start_all")!.cb({})).rejects.toThrow(
        "Daemon unavailable",
      );
    });

    it("services_stop_all forwards without params when names omitted", async () => {
      setMethodResult({ id: "r1", result: { stopped: ["api", "web"] } });

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
      setMethodResult({ id: "r1", result: { stopped: ["web"] } });

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
      setMethodResult({ id: "r1", result: { restarted: ["api", "web"] } });

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
      setMethodResult({ id: "r1", result: { restarted: ["api"] } });

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
      setMethodResult({ id: "r1", error: "Timeout" });

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

    it("collects a long stream through the inactivity-based ipcStream (E3)", async () => {
      mockIpcStream.mockImplementation(
        async (_sock: unknown, _method: unknown, _params: unknown, onEvent: unknown) => {
          const emit = onEvent as (event: string, data: unknown) => void;
          for (let i = 0; i < 500; i += 1) {
            emit("line", `line ${i}`);
          }
          return { id: "r1", result: { success: true } };
        },
      );

      const result = await registeredTools.get("tasks_run")!.cb({ key: "long" });

      // The 120s window is the inactivity timeout (resets on each line) — a task streaming for well over 2 minutes still completes.
      expect(mockIpcStream).toHaveBeenCalledWith(
        SOCK,
        "tasks.run",
        { key: "long" },
        expect.any(Function),
        120_000,
        SESSION,
      );
      const [{ text }] = (result as { content: { text: string }[] }).content;
      expect(text.split("\n")).toHaveLength(500);
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
      setMethodResult({ id: "r1", result: statuses });

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
      setMethodResult({ id: "r1", result: ["log1", "log2"] });

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
      setMethodError(err);

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
      );
    });

    it("request() catches ENOENT and returns friendly message", async () => {
      const err = new Error("connect ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      setMethodError(err);

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow(
        "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
      );
    });

    it("request() re-throws unknown errors", async () => {
      setMethodError(new Error("unexpected"));

      await expect(registeredTools.get("services_list")!.cb({})).rejects.toThrow("unexpected");
    });

    it("request() helper throws on IPC error", async () => {
      setMethodResult({ id: "r1", error: "Session expired" });

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

  // --- Sentra tools ---

  describe("sentra tools", () => {
    const ROW = {
      id: "01928f3a-6c1e-7b2a-9f4d-2c8e1a7b5d10",
      receivedAt: "2026-10-03T14:02:11.204Z",
      service: "web",
      kind: "error",
      level: "error",
      title: "TypeError: boom",
      location: "a.ts:1",
      issueId: "i1",
    };

    function sentraCall(method: string): unknown[] | undefined {
      return mockIpcRequest.mock.calls.findLast(([, name]) => name === method);
    }

    it("are read-only and describe the time-window pattern", () => {
      for (const name of ["sentra_errors", "sentra_issues", "sentra_show"]) {
        const meta = registeredTools.get(name)!.meta as {
          annotations: unknown;
          description: string;
        };
        expect(meta.annotations).toEqual({ readOnlyHint: true });
        if (name !== "sentra_show") {
          expect(meta.description).toContain(
            "Use `from` = ISO timestamp taken before reproducing/testing.",
          );
        }
      }
    });

    it("sentra_errors returns TOON with hasMore and passes sessionId as a param", async () => {
      setMethodResult({ id: "r1", result: { errors: [ROW], hasMore: true } });
      const res = await registeredTools.get("sentra_errors")!.cb({ since: "10m", limit: 1 });
      expect(res).toEqual({
        content: [
          {
            type: "text",
            text: expect.stringMatching(
              /^errors\[1\]\{id,receivedAt,service,kind,level,title,location,issueId\}:\n.*TypeError: boom.*\nhasMore: true$/s,
            ),
          },
        ],
      });
      expect(JSON.stringify(res)).not.toContain("next:");
      expect(sentraCall("sentra.errors")).toEqual([
        SOCK,
        "sentra.errors",
        { since: "10m", limit: 1, sessionId: SESSION },
        30_000,
      ]);
    });

    it("sentra_issues returns TOON", async () => {
      setMethodResult({ id: "r1", result: { issues: [], hasMore: false } });
      const res = await registeredTools.get("sentra_issues")!.cb({ minLevel: "error" });
      expect(res).toEqual({ content: [{ type: "text", text: "issues[0]:\nhasMore: false" }] });
      expect(sentraCall("sentra.issues")?.[2]).toEqual({ minLevel: "error", sessionId: SESSION });
    });

    it("sentra_show returns markdown", async () => {
      setMethodResult({
        id: "r1",
        result: { type: "item", item: { id: "x" }, markdown: "# TypeError: boom" },
      });
      const res = await registeredTools.get("sentra_show")!.cb({ id: "x" });
      expect(res).toEqual({ content: [{ type: "text", text: "# TypeError: boom" }] });
    });

    it.each([
      [
        'sentra_disabled: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.',
        'Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.',
      ],
      ["sentra_unavailable: port busy", "Sentra is unavailable: port busy"],
      [
        'not_found: No Sentra record or issue "x" in session sess1.',
        'No Sentra record or issue "x" in session sess1.',
      ],
      [
        "Unknown method: sentra.show",
        "This daemon is older than the CLI. Run `zaps daemon stop` and start again.",
      ],
    ])("maps daemon error %j to isError", async (daemonError, text) => {
      setMethodResult({ id: "r1", error: daemonError });
      const res = await registeredTools.get("sentra_show")!.cb({ id: "x" });
      expect(res).toEqual({ content: [{ type: "text", text }], isError: true });
    });

    it("reports a stopped daemon as isError", async () => {
      setMethodError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));
      const res = await registeredTools.get("sentra_errors")!.cb({});
      expect(res).toEqual({
        content: [
          {
            type: "text",
            text: "Daemon not running. Start with `zaps up` or `zaps daemon start`.",
          },
        ],
        isError: true,
      });
    });

    it("reports list failures and connection errors as isError", async () => {
      setSessionList({ id: "L", error: "boom" });
      const listError = await registeredTools.get("sentra_errors")!.cb({});
      expect(listError).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });

      mockIpcRequest.mockImplementation(async () => {
        throw new Error("socket gone");
      });
      const connError = await registeredTools.get("sentra_errors")!.cb({});
      expect(connError).toEqual({
        content: [{ type: "text", text: "socket gone" }],
        isError: true,
      });
    });

    it("falls back to the cwd config id when no session runs", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-mcp-sentra-"));
      const configPath = path.join(dir, ".zaps.mts");
      fs.writeFileSync(
        configPath,
        'export function config({ define }) {\n  return define({ name: "x", services: { web: { start: "true" } } });\n}\n',
      );
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      setSessionList({ id: "L", result: [] });
      setMethodResult({ id: "r1", result: { errors: [], hasMore: false } });
      try {
        await registeredTools.get("sentra_errors")!.cb({});
        expect(sentraCall("sentra.errors")?.[2]).toEqual({
          sessionId: sessionId(configPath, dir),
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns the no-config error as isError", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-mcp-noconf-"));
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      setSessionList({ id: "L", result: [] });
      try {
        const res = await registeredTools.get("sentra_errors")!.cb({});
        expect(res).toMatchObject({ isError: true });
        expect(JSON.stringify(res)).toContain("No .zaps.mts config found");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
