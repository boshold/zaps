import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { daemonHandlers } from "../../../src/daemon/handlers/daemon.js";
import { registerShutdownHook } from "../../../src/daemon/shutdown.js";
import type { IpcRequest } from "../../../src/lib/ipc/protocol.js";
import { createMockSession, createMockStore } from "../../_helpers/mock-session.js";

describe("daemon handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    registerShutdownHook(null);
  });

  describe("daemon.ping", () => {
    it("returns pong", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r1", method: "daemon.ping" };
      const res = await daemonHandlers["daemon.ping"](req, store);
      expect(res).toEqual({ id: "r1", result: "pong" });
    });
  });

  describe("daemon.status", () => {
    it("returns pid and session list", async () => {
      const session = createMockSession({ id: "s1", name: "my-proj" });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r2", method: "daemon.status" };
      const res = await daemonHandlers["daemon.status"](req, store);
      expect(res.id).toBe("r2");
      const result = res.result as { pid: number; sessions: unknown[] };
      expect(result.pid).toBe(process.pid);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({ id: "s1", name: "my-proj" });
    });

    it("returns empty sessions when none exist", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r3", method: "daemon.status" };
      const res = await daemonHandlers["daemon.status"](req, store);
      const result = res.result as { sessions: unknown[] };
      expect(result.sessions).toEqual([]);
    });
  });

  describe("daemon.shutdown", () => {
    it("runs the registered teardown hook before acking (D1)", async () => {
      const order: string[] = [];
      const hook = vi.fn(async () => {
        order.push("hook");
        return Promise.resolve();
      });
      registerShutdownHook(hook);

      const store = createMockStore();
      const req: IpcRequest = { id: "r4", method: "daemon.shutdown" };
      const res = await daemonHandlers["daemon.shutdown"](req, store);

      // Teardown ran deterministically as part of handling the request — not
      // Deferred to a timer the bun runtime can drop — and the caller is acked.
      expect(hook).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["hook"]);
      expect(res).toEqual({ id: "r4", result: { shuttingDown: true } });
    });

    it("still acks when no shutdown hook is registered", async () => {
      registerShutdownHook(null);

      const store = createMockStore();
      const req: IpcRequest = { id: "r4b", method: "daemon.shutdown" };
      const res = await daemonHandlers["daemon.shutdown"](req, store);
      expect(res).toEqual({ id: "r4b", result: { shuttingDown: true } });
    });
  });

  describe("session.list", () => {
    it("returns session info", async () => {
      const session = createMockSession({
        id: "s1",
        name: "proj",
        configPath: "/a/.zaps.mts",
        projectDir: "/a",
      });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r5", method: "session.list" };
      const res = await daemonHandlers["session.list"](req, store);
      const result = res.result as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "s1",
        name: "proj",
        configPath: "/a/.zaps.mts",
        projectDir: "/a",
        tmuxSession: "test-tmux",
        managed: false,
      });
    });

    it("reports the hosting tmux session + managed flag (F6/F7 hints)", async () => {
      const session = createMockSession({
        id: "s2",
        tmuxSession: "zaps-proj-abc123",
        tmuxSocket: "zaps",
        managedTmux: true,
      });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r5a", method: "session.list" };
      const res = await daemonHandlers["session.list"](req, store);
      expect((res.result as unknown[])[0]).toMatchObject({
        tmuxSession: "zaps-proj-abc123",
        managed: true,
      });
    });
  });

  describe("session.create", () => {
    it("creates session via store", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const req: IpcRequest = {
        id: "r6",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "main",
          originPane: "%0",
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.result).toMatchObject({
        id: session.id,
        name: session.name,
        focusPane: session.focusPane,
      });
    });

    it("returns error when configPath missing", async () => {
      const store = createMockStore();
      const req: IpcRequest = {
        id: "r7",
        method: "session.create",
        params: {},
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("configPath required");
    });

    it("forwards tmuxSocket + managedTmux to the store", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const req: IpcRequest = {
        id: "r6a",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "zaps-fake-abc123",
          originPane: "%0",
          tmuxSocket: "zaps",
          managedTmux: true,
        },
      };
      await daemonHandlers["session.create"](req, store);
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({ tmuxSocket: "zaps", managedTmux: true }),
      );
    });

    it("defaults to the user's default server when no socket is sent", async () => {
      const session = createMockSession();
      const store = createMockStore([session]);
      const req: IpcRequest = {
        id: "r6b",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "main",
          originPane: "%0",
        },
      };
      await daemonHandlers["session.create"](req, store);
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({ backend: "tmux", tmuxSession: "main" }),
      );
    });

    it.each(["", "   "])("rejects a blank tmuxSocket (%j)", async (socket) => {
      const store = createMockStore();
      const req: IpcRequest = {
        id: "r6c",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "main",
          originPane: "%0",
          tmuxSocket: socket,
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("tmuxSocket must be a non-empty string or null");
      expect(store.create).not.toHaveBeenCalled();
    });

    it("rejects managedTmux without a socket — never kill-session on the default server", async () => {
      const store = createMockStore();
      const req: IpcRequest = {
        id: "r6d",
        method: "session.create",
        params: {
          configPath: "/fake/.zaps.mts",
          projectDir: "/fake",
          tmuxSession: "main",
          originPane: "%0",
          managedTmux: true,
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("managed session requires tmuxSocket");
      expect(store.create).not.toHaveBeenCalled();
    });

    it("returns error when store.create throws", async () => {
      const store = createMockStore();
      vi.mocked(store.create).mockRejectedValue(new Error("load failed"));
      const req: IpcRequest = {
        id: "r8",
        method: "session.create",
        params: {
          configPath: "/bad/.zaps.mts",
          projectDir: "/bad",
          tmuxSession: "main",
          originPane: "%0",
        },
      };
      const res = await daemonHandlers["session.create"](req, store);
      expect(res.error).toBe("load failed");
    });
  });

  describe("session.destroy", () => {
    it("destroys existing session", async () => {
      const session = createMockSession({ id: "s1" });
      const store = createMockStore([session]);
      const req: IpcRequest = { id: "r9", method: "session.destroy", session: "s1" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.result).toEqual({ destroyed: "s1" });
      expect(store.destroy).toHaveBeenCalledWith("s1");
    });

    it("returns error when session required but missing", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r10", method: "session.destroy" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.error).toBe("session required");
    });

    it("returns error when session not found", async () => {
      const store = createMockStore();
      const req: IpcRequest = { id: "r11", method: "session.destroy", session: "unknown" };
      const res = await daemonHandlers["session.destroy"](req, store);
      expect(res.error).toContain("Unknown session");
    });
  });
});

describe("backend create boundary", () => {
  const params = { backend: "shell", configPath: "/fake/.zaps.mts", projectDir: "/fake" };

  it("publishes shell metadata without injecting tmux defaults", async () => {
    const session = createMockSession({
      backend: {
        id: "shell",
        capabilities: {
          panes: false,
          zoom: false,
          popups: false,
          taskPanes: false,
          rawInput: false,
          layout: false,
        },
      },
      compatibilityProjection: () => ({ backend: "shell", paneMap: {} }),
    });
    const store = createMockStore([session]);
    const response = await daemonHandlers["session.create"](
      { id: "r", method: "session.create", params },
      store,
    );
    expect(response.result).toMatchObject({ backend: "shell", paneMap: {} });
    expect(response.result).not.toHaveProperty("focusPane");
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining(params));
    expect(store.create).not.toHaveBeenCalledWith(expect.objectContaining({ tmuxSocket: null }));
    const list = await daemonHandlers["session.list"]({ id: "l", method: "session.list" }, store);
    expect(list.result).toEqual([expect.objectContaining({ backend: "shell" })]);
    const status = await daemonHandlers["daemon.status"](
      { id: "s", method: "daemon.status" },
      store,
    );
    expect(status.result).toMatchObject({ supportedBackends: ["tmux", "shell"] });
  });

  it("advertises implicit session support", async () => {
    const status = await daemonHandlers["daemon.status"](
      { id: "s", method: "daemon.status" },
      createMockStore(),
    );
    expect(status.result).toMatchObject({ capabilities: { implicitSessions: true } });
  });

  it("lists lifecycle flags only when set", async () => {
    const shell = {
      backend: {
        id: "shell" as const,
        capabilities: {
          panes: false,
          zoom: false,
          popups: false,
          taskPanes: false,
          rawInput: false,
          layout: false,
        },
      },
      compatibilityProjection: () => ({ backend: "shell" as const, paneMap: {} }),
    };
    const pending = createMockSession({
      ...shell,
      id: "pending",
      startupPending: true,
      ephemeral: true,
    });
    const idle = createMockSession({ ...shell, id: "idle" });
    const store = createMockStore([pending, idle]);
    const list = await daemonHandlers["session.list"]({ id: "l", method: "session.list" }, store);
    const [first, second] = z.array(z.record(z.string(), z.unknown())).parse(list.result);
    expect(first).toMatchObject({ id: "pending", startupPending: true, ephemeral: true });
    expect(second).not.toHaveProperty("startupPending");
    expect(second).not.toHaveProperty("ephemeral");
  });

  it("forwards startServices and ephemeral to the store", async () => {
    const session = createMockSession({
      backend: {
        id: "shell" as const,
        capabilities: {
          panes: false,
          zoom: false,
          popups: false,
          taskPanes: false,
          rawInput: false,
          layout: false,
        },
      },
      compatibilityProjection: () => ({ backend: "shell", paneMap: {} }),
    });
    const store = createMockStore([session]);
    const response = await daemonHandlers["session.create"](
      {
        id: "r",
        method: "session.create",
        params: { ...params, startServices: false, ephemeral: true },
      },
      store,
    );
    expect(response.result).toMatchObject({ backend: "shell" });
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ startServices: false, ephemeral: true }),
    );
  });

  it.each([{ ephemeral: true }, { ephemeral: true, startServices: true }])(
    "rejects ephemeral without startServices: false %j",
    async (fields) => {
      const store = createMockStore();
      const response = await daemonHandlers["session.create"](
        { id: "r", method: "session.create", params: { ...params, ...fields } },
        store,
      );
      expect(response).toMatchObject({ errorCode: "invalid_request" });
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it.each([{ startServices: false }, { ephemeral: false }])(
    "rejects lifecycle fields on the tmux variant %j",
    async (fields) => {
      const store = createMockStore();
      const response = await daemonHandlers["session.create"](
        {
          id: "r",
          method: "session.create",
          params: {
            backend: "tmux",
            configPath: "/fake/.zaps.mts",
            projectDir: "/fake",
            tmuxSession: "main",
            originPane: "%0",
            ...fields,
          },
        },
        store,
      );
      expect(response).toMatchObject({ errorCode: "invalid_request" });
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tmuxSession: "main" },
    { originPane: "%0" },
    { tmuxSocket: null },
    { managedTmux: false },
  ])("rejects shell host fields %j before store", async (fields) => {
    const store = createMockStore();
    const response = await daemonHandlers["session.create"](
      { id: "r", method: "session.create", params: { ...params, ...fields } },
      store,
    );
    expect(response).toMatchObject({ errorCode: "invalid_request" });
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each(["future", undefined, null])(
    "rejects explicit unsupported backend %j",
    async (backend) => {
      const store = createMockStore();
      const response = await daemonHandlers["session.create"](
        { id: "r", method: "session.create", params: { ...params, backend } },
        store,
      );
      expect(response).toMatchObject({ errorCode: "invalid_backend" });
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed context before creation", async () => {
    const store = createMockStore();
    const req = { id: "r", method: "session.create", params };
    Object.defineProperty(req, "context", { value: { cwd: "relative", env: {} } });
    const response = await daemonHandlers["session.create"](req, store);
    expect(response).toMatchObject({
      error: "invalid request context",
      errorCode: "invalid_request",
    });
    expect(store.create).not.toHaveBeenCalled();
  });
});
