import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { unavailableActions, unavailableCapabilities } from "../../src/lib/backend/wire.js";
import type { SubscribeHandlers } from "../../src/lib/ipc/client.js";
import type { IpcResponse } from "../../src/lib/ipc/protocol.js";
import { acceptMockResponse } from "../_helpers/accept-mock-response.js";
import { deferred } from "../_helpers/deferred.js";
import { makeSessionSnapshot as wireSnapshot } from "../_helpers/session-snapshot.js";

const mockIpcRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcStream = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIpcSubscribe = vi.fn();

vi.mock("../../src/lib/ipc/client.js", () => ({
  ipcRequest: async (...args: unknown[]) => mockIpcRequest(...args),
  ipcStream: async (...args: unknown[]) => mockIpcStream(...args),
  ipcSubscribe: (...args: unknown[]) => mockIpcSubscribe(...args),
}));

const { DaemonClient, TerminalActionError } = await import("../../src/client/daemon-client.js");
const modernStatus = {
  id: "s",
  result: { pid: 1, sessions: [], supportedBackends: ["tmux", "shell"] },
};
const legacyStatus = { id: "s", result: { pid: 2, sessions: [] } };

describe("DaemonClient", () => {
  let client: InstanceType<typeof DaemonClient>;
  let mockSub: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<IpcResponse>>>;
    connected: boolean;
    subscribed: Promise<void>;
  };
  let eventHandler: SubscribeHandlers["onEvent"];
  let closeHandler: () => void;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSub = {
      send: vi.fn(),
      close: vi.fn(),
      request: vi.fn(),
      connected: true,
      subscribed: Promise.resolve(),
    };

    mockIpcSubscribe.mockImplementation(
      (
        _sock: string,
        _session: string,
        _events: string[],
        { onEvent, onClose }: SubscribeHandlers,
      ) => {
        eventHandler = onEvent;
        closeHandler =
          onClose ??
          (() => {
            /* Noop */
          });
        const fixture = mockSub;
        return {
          ...fixture,
          get subscribed() {
            return fixture.subscribed;
          },
          request: acceptMockResponse(fixture.request),
        };
      },
    );

    client = new DaemonClient("/test.sock", "sess1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects via ipcSubscribe", () => {
    client.connect();
    expect(mockIpcSubscribe).toHaveBeenCalledWith("/test.sock", "sess1", expect.any(Array), {
      onEvent: expect.any(Function),
      onClose: expect.any(Function),
    });
  });

  it("reports connected state", () => {
    expect(client.connected).toBe(false);
    client.connect();
    expect(client.connected).toBe(true);
  });

  it("returns session id", () => {
    expect(client.session).toBe("sess1");
  });

  it("disconnect sends detach and closes", () => {
    client.connect();
    client.disconnect();
    expect(mockSub.send).toHaveBeenCalledWith("session.detach");
    expect(mockSub.close).toHaveBeenCalled();
  });

  it("disconnect is safe when not connected", () => {
    expect(() => client.disconnect()).not.toThrow();
  });

  it("emits disconnect on close", () => {
    const spy = vi.fn();
    client.on("disconnect", spy);
    client.connect();
    closeHandler();
    expect(spy).toHaveBeenCalled();
  });

  describe("awaitable detach", () => {
    it("legacy binding ACK does not prove managed host detach support", async () => {
      const {
        backend: _backend,
        capabilities: _capabilities,
        ...legacy
      } = wireSnapshot({ managed: true });
      mockSub.request
        .mockResolvedValueOnce(legacyStatus)
        .mockResolvedValueOnce({ id: "a", result: legacy });
      await client.connectUi();
      await expect(client.detach({ detachHost: true })).rejects.toThrow("Restart the daemon");
      expect(mockSub.request).toHaveBeenCalledTimes(2);
      expect(client.uiBound).toBe(true);
      expect(client.canQuitOffline).toBe(false);
      expect(mockSub.close).not.toHaveBeenCalled();
    });

    it("legacy personal UI can unsubscribe", async () => {
      const { backend: _backend, capabilities: _capabilities, ...legacy } = wireSnapshot();
      mockSub.request
        .mockResolvedValueOnce(legacyStatus)
        .mockResolvedValueOnce({ id: "a", result: legacy });
      await client.connectUi();
      mockSub.request.mockResolvedValueOnce({ id: "d", result: { detached: true } });
      await client.detach({ detachHost: true });
      expect(mockSub.request).toHaveBeenLastCalledWith("session.detach", { detachHost: true });
      expect(client.uiBound).toBe(false);
      expect(mockSub.close).toHaveBeenCalledTimes(1);
    });

    it("trusted support awaits bound RPC and retains binding on failure", async () => {
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: wireSnapshot({ managed: true }) });
      await client.connectUi();
      mockSub.request.mockResolvedValueOnce({
        id: "d",
        error: "backend_unavailable",
        errorCode: "backend_unavailable",
      });
      await expect(client.detach({ detachHost: true })).rejects.toMatchObject({
        code: "backend_unavailable",
      });
      expect(client.uiBound).toBe(true);
      expect(mockSub.close).not.toHaveBeenCalled();
      const acknowledge = deferred<IpcResponse>();
      mockSub.request.mockReturnValueOnce(acknowledge.promise);
      const detach = client.detach({ detachHost: true });
      expect(mockSub.request).toHaveBeenLastCalledWith("session.detach", { detachHost: true });
      expect(client.uiBound).toBe(true);
      expect(mockSub.close).not.toHaveBeenCalled();
      acknowledge.resolve({ id: "d", result: { detached: true } });
      await detach;
      expect(client.uiBound).toBe(false);
      expect(mockSub.close).toHaveBeenCalledTimes(1);
      expect(mockIpcRequest).not.toHaveBeenCalled();
    });

    it("requires modern bound metadata even when the daemon advertises support", async () => {
      const {
        backend: _backend,
        capabilities: _capabilities,
        ...legacy
      } = wireSnapshot({ managed: true });
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: legacy });
      await client.connectUi();
      await expect(client.detach({ detachHost: true })).rejects.toThrow("Restart the daemon");
      expect(mockSub.request).toHaveBeenCalledTimes(2);
      expect(client.uiBound).toBe(true);
    });

    it("keeps last verified host metadata offline", async () => {
      expect(client.canQuitOffline).toBe(false);
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: wireSnapshot() });
      await client.connectUi();
      closeHandler();
      expect(client.canQuitOffline).toBe(true);
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: wireSnapshot({ id: "other", managed: true }) });
      await expect(client.connectUi()).rejects.toThrow("different session");
      expect(client.canQuitOffline).toBe(true);
    });

    it.each<IpcResponse>([
      { id: "d", result: { detached: true }, error: "ambiguous" },
      { id: "d", result: { detached: true }, errorCode: "backend_unavailable" },
      { id: "d", result: { detached: true, extra: true } },
      { id: "d", result: { detached: false } },
    ])("rejects malformed detach acknowledgement %j", async (response) => {
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: wireSnapshot({ managed: true }) })
        .mockResolvedValueOnce(response);
      await client.connectUi();
      await expect(client.detach({ detachHost: true })).rejects.toThrow("Invalid detach response");
      expect(client.uiBound).toBe(true);
      expect(mockSub.close).not.toHaveBeenCalled();
    });

    it("rejects a valid detach ACK after its socket is replaced", async () => {
      const ack = deferred<IpcResponse>();
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: wireSnapshot({ managed: true }) })
        .mockReturnValueOnce(ack.promise)
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "b", result: wireSnapshot({ managed: true }) });
      await client.connectUi();
      const detach = client.detach({ detachHost: true });
      const rejected = expect(detach).rejects.toThrow("daemon connection closed");
      await client.connectUi();
      ack.resolve({ id: "d", result: { detached: true } });
      await rejected;
      expect(client.uiBound).toBe(true);
      expect(mockSub.close).toHaveBeenCalledOnce();
    });
  });

  describe("UI binding", () => {
    it("waits for subscribe ACK then uses the persistent socket and awaits attach ACK", async () => {
      const acknowledgements: { subscribe?: () => void; attach?: () => void } = {};
      mockSub.subscribed = new Promise<void>((resolve) => {
        acknowledgements.subscribe = resolve;
      });
      mockSub.request.mockReturnValue(
        new Promise((resolve) => {
          acknowledgements.attach = () => resolve({ id: "attach", result: wireSnapshot() });
        }),
      );
      client.connect();
      const binding = client.bindUi();
      expect(client.uiBound).toBe(false);
      expect(mockSub.request).not.toHaveBeenCalled();
      acknowledgements.subscribe?.();
      await vi.waitFor(() =>
        expect(mockSub.request).toHaveBeenCalledWith(
          "session.attach",
          { ui: true },
          undefined,
          expect.any(Function),
        ),
      );
      expect(client.uiBound).toBe(false);
      acknowledgements.attach?.();
      await expect(binding).resolves.toEqual(wireSnapshot());
      expect(client.uiBound).toBe(true);
      expect(mockIpcRequest).not.toHaveBeenCalled();
      client.disconnect();
      expect(client.uiBound).toBe(false);
    });

    it("propagates subscribe and binding failures", async () => {
      await expect(client.bindUi()).rejects.toThrow("Not connected");
      client.connect();
      mockSub.subscribed = Promise.reject(new Error("subscribe failed"));
      await expect(client.bindUi()).rejects.toThrow("subscribe failed");
      expect(mockSub.request).not.toHaveBeenCalled();
      mockSub.subscribed = Promise.resolve();
      mockSub.request.mockResolvedValue({ id: "a", error: "invalid_request" });
      await expect(client.bindUi()).rejects.toThrow("invalid_request");
      expect(client.uiBound).toBe(false);
    });

    it("settles binding when disconnected before subscribe ACK", async () => {
      let loseSubscription: ((reason: Error) => void) | undefined = undefined;
      mockSub.subscribed = new Promise<void>((_resolve, reject) => {
        loseSubscription = reject;
      });
      mockSub.close.mockImplementation(() =>
        loseSubscription?.(new Error("daemon connection closed")),
      );
      client.connect();
      const binding = client.bindUi();
      client.disconnect();
      await expect(binding).rejects.toThrow("daemon connection closed");
      expect(mockSub.request).not.toHaveBeenCalled();
      expect(client.uiBound).toBe(false);
    });

    it("does not bind after disconnect during attach", async () => {
      const acknowledgements: { attach?: () => void } = {};
      mockSub.request.mockReturnValue(
        new Promise((resolve) => {
          acknowledgements.attach = () => resolve({ id: "a", result: wireSnapshot() });
        }),
      );
      client.connect();
      const binding = client.bindUi();
      await vi.waitFor(() => expect(mockSub.request).toHaveBeenCalled());
      client.disconnect();
      acknowledgements.attach?.();
      await expect(binding).rejects.toThrow("daemon connection closed");
      expect(client.uiBound).toBe(false);
    });

    it("requires a fresh subscribe and attach handshake on reconnect", async () => {
      mockSub.request.mockResolvedValue({ id: "a", result: wireSnapshot() });
      client.connect();
      await client.bindUi();
      expect(client.uiBound).toBe(true);
      closeHandler();
      expect(client.uiBound).toBe(false);
      mockSub = {
        ...mockSub,
        request: vi.fn().mockResolvedValue({ id: "b", result: wireSnapshot() }),
      };
      client.connect();
      expect(client.uiBound).toBe(false);
      await client.bindUi();
      expect(mockSub.request).toHaveBeenCalledOnce();
      expect(client.uiBound).toBe(true);
    });
  });

  describe("UI attachment lifecycle", () => {
    it("ignores status from a replaced socket and retains the current legacy binding", async () => {
      const oldStatus = deferred<IpcResponse>();
      mockSub.request.mockReturnValueOnce(oldStatus.promise);
      const old = client.connectUi();
      const rejected = expect(old).rejects.toThrow("daemon connection closed");
      await vi.waitFor(() =>
        expect(mockSub.request).toHaveBeenCalledExactlyOnceWith("daemon.status"),
      );
      const oldRequest = mockSub.request;
      mockSub = {
        ...mockSub,
        request: vi
          .fn()
          .mockResolvedValueOnce(legacyStatus)
          .mockResolvedValueOnce({ id: "a", result: wireSnapshot({ managed: true }) }),
      };
      await client.connectUi();
      oldStatus.resolve(modernStatus);
      await rejected;
      expect(oldRequest).toHaveBeenCalledOnce();
      await expect(client.detach({ detachHost: true })).rejects.toThrow("Restart the daemon");
      expect(mockSub.request).toHaveBeenCalledTimes(2);
      expect(client.uiBound).toBe(true);
    });

    it("refreshes advertisement on reconnect and ignores old callbacks", async () => {
      const modern = wireSnapshot({ capabilities: { ...unavailableCapabilities, panes: true } });
      mockSub.request
        .mockResolvedValueOnce(modernStatus)
        .mockResolvedValueOnce({ id: "a", result: modern });
      await expect(client.connectUi()).resolves.toEqual(modern);
      const oldClose = closeHandler;
      const oldEvent = eventHandler;
      const disconnected = vi.fn();
      const reloaded = vi.fn();
      client.on("disconnect", disconnected);
      client.on("session.configReloaded", reloaded);

      const { backend: _backend, capabilities: _caps, ...legacy } = modern;
      mockSub = {
        ...mockSub,
        request: vi
          .fn()
          .mockResolvedValueOnce(legacyStatus)
          .mockResolvedValue({
            id: "a",
            result: {
              ...legacy,
              statuses: [{ name: "web", state: "ready", ports: [], retryCount: 0 }],
            },
          }),
      };
      const fresh = await client.connectUi();
      expect(fresh.backend).toBe("tmux");
      expect(fresh.capabilities).toEqual(unavailableCapabilities);
      expect(fresh.statuses[0]?.actions).toEqual(unavailableActions);

      oldClose();
      oldEvent({ session: "sess1", event: "session.configReloaded", data: modern });
      expect(disconnected).not.toHaveBeenCalled();
      expect(reloaded).not.toHaveBeenCalled();
      expect(client.uiBound).toBe(true);

      const notice = vi.fn();
      client.on("config.notice", notice);
      client.deliverUpgradeNotice();
      client.deliverUpgradeNotice();
      expect(notice).toHaveBeenCalledExactlyOnceWith(
        "warn",
        expect.stringContaining("Restart the daemon"),
      );
    });

    it("revokes terminal actions when the current session is destroyed", async () => {
      client.connect();
      mockSub.request.mockResolvedValueOnce({ id: "a", result: wireSnapshot() });
      await client.bindUi();
      eventHandler({ session: "sess1", event: "session.destroyed" });
      expect(client.uiBound).toBe(false);
      expect(mockSub.close).toHaveBeenCalledOnce();
      await expect(client.terminalAction({ action: "taskPicker" })).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("rejects malformed shell metadata without publishing a snapshot or hint", async () => {
      mockSub.request.mockResolvedValueOnce(legacyStatus).mockResolvedValueOnce({
        id: "a",
        result: { ...wireSnapshot(), backend: "shell" },
      });
      const snapshot = vi.fn();
      const notice = vi.fn();
      client.on("session.snapshot", snapshot);
      client.on("config.notice", notice);
      await expect(client.connectUi()).rejects.toThrow();
      expect(client.uiBound).toBe(false);
      expect(snapshot).not.toHaveBeenCalled();
      expect(notice).not.toHaveBeenCalled();
      expect(mockSub.close).toHaveBeenCalledOnce();
    });
  });

  describe("terminal actions", () => {
    it("requires UI acknowledgement", async () => {
      client.connect();
      await expect(client.terminalAction({ action: "taskPicker" })).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(mockSub.request).not.toHaveBeenCalled();
    });

    it("uses the bound socket without timeout beyond ordinary RPC duration", async () => {
      mockSub.request.mockResolvedValueOnce({ id: "attach", result: wireSnapshot() });
      client.connect();
      await client.bindUi();
      vi.useFakeTimers();
      try {
        let complete: ((response: IpcResponse) => void) | undefined;
        mockSub.request.mockReturnValueOnce(
          new Promise((resolve) => {
            complete = resolve;
          }),
        );
        let settled = false;
        const action = client.terminalAction({ action: "taskPicker" }).then((result) => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(settled).toBe(false);
        expect(mockSub.request).toHaveBeenLastCalledWith(
          "terminal.action",
          { action: "taskPicker" },
          0,
        );
        complete?.({ id: "picker", result: { action: "taskPicker", taskKey: null } });
        await expect(action).resolves.toEqual({ action: "taskPicker", taskKey: null });
        expect(mockIpcRequest).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { id: "selection", result: { action: "taskPicker", taskKey: "build" } },
      { id: "unavailable", error: "missing fzf", errorCode: "backend_unavailable" },
    ] satisfies IpcResponse[])(
      "discards a terminal response from a replaced binding ($id)",
      async (response) => {
        mockSub.request.mockResolvedValueOnce({ id: "attach", result: wireSnapshot() });
        client.connect();
        await client.bindUi();
        const pending = deferred<IpcResponse>();
        mockSub.request.mockReturnValueOnce(pending.promise);
        const action = client.terminalAction({ action: "taskPicker" });
        const rejected = expect(action).rejects.toThrow("daemon connection closed");
        client.connect();
        mockSub.request.mockResolvedValueOnce({ id: "reattach", result: wireSnapshot() });
        await client.bindUi();
        expect(client.uiBound).toBe(true);
        pending.resolve(response);
        await rejected;
      },
    );

    it.each([
      { id: "null-error", error: null, errorCode: "backend_unavailable" },
      {
        id: "mixed-reply",
        error: "missing fzf",
        errorCode: "backend_unavailable",
        result: { action: "taskPicker", taskKey: "build" },
      },
      {
        id: "selection-with-error-code",
        result: { action: "taskPicker", taskKey: "build" },
        errorCode: "backend_unavailable",
      },
    ])("rejects a malformed terminal reply ($id) before dispatch", async (response) => {
      const request = acceptMockResponse(mockSub.request);
      mockIpcSubscribe.mockReturnValueOnce({
        ...mockSub,
        request: async (...args: Parameters<typeof request>) =>
          args[0] === "terminal.action" ? response : request(...args),
      });
      mockSub.request.mockResolvedValueOnce({ id: "attach", result: wireSnapshot() });
      client.connect();
      await client.bindUi();

      await expect(client.terminalAction({ action: "taskPicker" })).rejects.toBeInstanceOf(
        ZodError,
      );
    });

    it.each([
      { id: "typed", error: "missing fzf", errorCode: "backend_unavailable" },
      { id: "legacy", error: "unavailable" },
    ] satisfies IpcResponse[])("preserves a valid terminal error ($id)", async (response) => {
      mockSub.request.mockResolvedValueOnce({ id: "attach", result: wireSnapshot() });
      client.connect();
      await client.bindUi();
      mockSub.request.mockResolvedValueOnce(response);
      const action = client.terminalAction({ action: "taskPicker" });

      await expect(action).rejects.toBeInstanceOf(TerminalActionError);
      await expect(action).rejects.toMatchObject({
        message: response.error,
        code: response.errorCode,
      });
    });

    it("preserves busy errors without fallback and rejects socket loss", async () => {
      mockSub.request.mockResolvedValueOnce({ id: "attach", result: wireSnapshot() });
      client.connect();
      await client.bindUi();
      mockSub.request.mockResolvedValueOnce({
        id: "busy",
        error: "occupied",
        errorCode: "terminal_busy",
      });
      await expect(client.terminalAction({ action: "taskPicker" })).rejects.toMatchObject({
        code: "terminal_busy",
        message: "occupied",
      });
      mockSub.request.mockRejectedValueOnce(new Error("daemon connection closed"));
      await expect(client.terminalAction({ action: "taskPicker" })).rejects.toThrow(
        "daemon connection closed",
      );
      expect(mockIpcRequest).not.toHaveBeenCalled();
    });
  });

  describe("backend decoding", () => {
    it("shell binding can quit without host-detach trust", async () => {
      const {
        tmuxSession: _session,
        managed: _managed,
        originPane: _origin,
        ...common
      } = wireSnapshot();
      client.connect();
      mockSub.request.mockResolvedValueOnce({ id: "a", result: { ...common, backend: "shell" } });
      await client.bindUi();
      mockSub.request.mockResolvedValueOnce({ id: "d", result: { detached: true } });
      await client.detach({ detachHost: true });
      expect(client.uiBound).toBe(false);
      expect(mockSub.close).toHaveBeenCalledOnce();
    });

    it("rejects explicit malformed binding metadata", async () => {
      client.connect();
      mockSub.request.mockResolvedValueOnce({
        id: "a",
        result: { ...wireSnapshot(), backend: undefined },
      });
      await expect(client.bindUi()).rejects.toThrow();
      expect(client.uiBound).toBe(false);
    });

    it("ignores malformed updates and emits one established upgrade hint", async () => {
      const update = vi.fn();
      const reload = vi.fn();
      const notice = vi.fn();
      client.on("service.stateChange", update);
      client.on("session.configReloaded", reload);
      client.on("config.notice", notice);
      client.connect();
      eventHandler({
        session: "sess1",
        event: "service.stateChange",
        data: { name: "api", status: { state: "ready" } },
      });
      eventHandler({
        session: "sess1",
        event: "session.configReloaded",
        data: { ...wireSnapshot(), backend: "future" },
      });
      expect(update).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      mockIpcRequest.mockResolvedValue({ id: "r", result: wireSnapshot() });
      await client.attach();
      await client.attach();
      expect(notice).toHaveBeenCalledOnce();
      expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("Restart the daemon"));
    });

    it("exposes parsed advertisement and preserves typed service errors", async () => {
      mockIpcRequest.mockResolvedValueOnce({ id: "r", result: { pid: 42, sessions: [] } });
      expect(await client.status()).toMatchObject({
        advertised: false,
        supportedBackends: ["tmux"],
      });
      mockIpcRequest.mockResolvedValueOnce({
        id: "r",
        error: "closing",
        errorCode: "session_closing",
      });
      await expect(client.startService("api")).rejects.toMatchObject({
        message: "closing",
        code: "session_closing",
      });
    });
  });

  describe("request methods", () => {
    beforeEach(() => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: "ok" });
    });

    it("attach returns snapshot", async () => {
      const snapshot = wireSnapshot();
      mockIpcRequest.mockResolvedValue({ id: "r1", result: snapshot });
      const result = await client.attach();
      expect(result).toEqual(snapshot);
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.attach",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("attach throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Unknown session" });
      await expect(client.attach()).rejects.toThrow("Unknown session");
    });

    it("reloadConfig", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { reloaded: true } });
      await client.reloadConfig();
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.reload",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("reloadConfig throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "Config invalid" });
      await expect(client.reloadConfig()).rejects.toThrow("Config invalid");
    });

    it("destroySession", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { destroyed: "sess1" } });
      await client.destroySession();
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "session.destroy",
        undefined,
        30_000,
        "sess1",
      );
    });

    it("destroySession throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "fail" });
      await expect(client.destroySession()).rejects.toThrow("fail");
    });

    it.each([
      { id: "d", result: { destroyed: "sess1" }, error: "cleanup failed" },
      { id: "d", result: { destroyed: "sess1" }, errorCode: "session_closing" },
      { id: "d", result: { destroyed: "sess1", extra: true } },
      { id: "d", result: { destroyed: true } },
      { id: "d", result: { destroyed: "other" } },
    ])("rejects malformed shutdown acknowledgement %j", async (response) => {
      mockIpcRequest.mockResolvedValueOnce(response);
      await expect(client.destroySession()).rejects.toThrow(
        /Invalid shutdown response|different session/,
      );
    });

    it("listServices", async () => {
      const statuses = [
        { name: "api", state: "ready", ports: [], retryCount: 0, actions: unavailableActions },
      ];
      mockIpcRequest.mockResolvedValue({ id: "r1", result: statuses });
      const result = await client.listServices();
      expect(result).toEqual(statuses);
    });

    it("startService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { started: "api" } });
      await client.startService("api");
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "services.start",
        { name: "api" },
        30_000,
        "sess1",
      );
    });

    it("stopService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { stopped: "api" } });
      await client.stopService("api");
    });

    it("restartService", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: "api" } });
      await client.restartService("api");
    });

    it("restartAll", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { restarted: "all" } });
      await client.restartAll();
    });

    it("getLogSnapshot", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: ["line1", "line2"] });
      const result = await client.getLogSnapshot("api");
      expect(result).toEqual(["line1", "line2"]);
    });

    it("listServices throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "list fail" });
      await expect(client.listServices()).rejects.toThrow("list fail");
    });

    it("stopService throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "stop fail" });
      await expect(client.stopService("api")).rejects.toThrow("stop fail");
    });

    it("restartService throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "restart fail" });
      await expect(client.restartService("api")).rejects.toThrow("restart fail");
    });

    it("restartAll throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "restartAll fail" });
      await expect(client.restartAll()).rejects.toThrow("restartAll fail");
    });

    it("getLogSnapshot throws on error", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "log fail" });
      await expect(client.getLogSnapshot("api")).rejects.toThrow("log fail");
    });
  });

  describe("runTask", () => {
    it("streams task output", async () => {
      mockIpcStream.mockImplementation(
        async (_sock: unknown, _method: unknown, _params: unknown, onEvent: unknown) => {
          const emit = onEvent as (event: string, data: unknown) => void;
          emit("line", "output1");
          emit("progress", { key: "sub", result: "success" });
          return { id: "r1", result: { success: true } };
        },
      );

      const onLine = vi.fn();
      const onProgress = vi.fn();
      const result = await client.runTask("build", { onLine, onProgress });

      expect(result).toEqual({ success: true });
      expect(onLine).toHaveBeenCalledWith("output1");
      expect(onProgress).toHaveBeenCalledWith("sub", "success");
    });

    it("surfaces runId from the stream response", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", result: { success: true, runId: "run_7" } });
      const result = await client.runTask("build", {});
      expect(result).toEqual({ success: true, runId: "run_7" });
    });

    it("tolerates a stream response without a runId (older daemon)", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", result: { success: true } });
      const result = await client.runTask("build", {});
      expect(result.runId).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it("throws on error response", async () => {
      mockIpcStream.mockResolvedValue({ id: "r1", error: "task error" });
      await expect(client.runTask("bad", {})).rejects.toThrow("task error");
    });
  });

  describe("runTaskInPane", () => {
    it("returns runId + paneId and forwards the target", async () => {
      mockIpcRequest.mockResolvedValue({
        id: "r1",
        result: { runId: "run_1", paneId: "%5" },
      });
      const result = await client.runTaskInPane("build", "pane");
      expect(result).toEqual({ runId: "run_1", paneId: "%5" });
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "tasks.runInPane",
        { key: "build", target: "pane" },
        expect.any(Number),
        "sess1",
      );
    });

    it("omits target when not given", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", result: { runId: "run_2", paneId: "%6" } });
      await client.runTaskInPane("build");
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "tasks.runInPane",
        { key: "build" },
        expect.any(Number),
        "sess1",
      );
    });

    it("throws on error response", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "tmux_failed" });
      await expect(client.runTaskInPane("build")).rejects.toThrow("tmux_failed");
    });
  });

  describe("getTaskOutput", () => {
    it("issues tasks.output and resolves the buffer", async () => {
      const snapshot = {
        runId: "run_9",
        taskKey: "build",
        result: "error",
        lines: ["compiling", "boom"],
        startedAt: 1000,
        endedAt: 2000,
      };
      mockIpcRequest.mockResolvedValue({ id: "r1", result: snapshot });

      const result = await client.getTaskOutput("run_9");

      expect(result).toEqual(snapshot);
      expect(mockIpcRequest).toHaveBeenCalledWith(
        "/test.sock",
        "tasks.output",
        { runId: "run_9" },
        30_000,
        "sess1",
      );
    });

    it("rejects with not_found when the buffer was evicted or unknown", async () => {
      mockIpcRequest.mockResolvedValue({ id: "r1", error: "not_found" });
      await expect(client.getTaskOutput("gone")).rejects.toThrow("not_found");
    });
  });

  describe("event routing", () => {
    it("routes service.stateChange", () => {
      const spy = vi.fn();
      client.on("service.stateChange", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "service.stateChange",
        data: { name: "api", status: { name: "api", state: "ready", ports: [], retryCount: 0 } },
      });

      expect(spy).toHaveBeenCalledWith("api", {
        name: "api",
        state: "ready",
        ports: [],
        retryCount: 0,
        actions: unavailableActions,
      });
    });

    it("routes log.lines", () => {
      const spy = vi.fn();
      client.on("log.lines", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "log.lines",
        data: { service: "api", lines: ["hi"] },
      });

      expect(spy).toHaveBeenCalledWith("api", ["hi"]);
    });

    it("routes task.start", () => {
      const spy = vi.fn();
      client.on("task.start", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "task.start",
        data: { key: "build", name: "Build", runId: "run_1" },
      });

      expect(spy).toHaveBeenCalledWith("build", "Build", "run_1");
    });

    it("routes task.complete", () => {
      const spy = vi.fn();
      client.on("task.complete", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "task.complete",
        data: { key: "build", name: "Build", result: "success", runId: "run_1" },
      });

      expect(spy).toHaveBeenCalledWith("build", "Build", "success", "run_1");
    });

    it("re-emits task events with runId undefined when absent (older daemon)", () => {
      const startSpy = vi.fn();
      const completeSpy = vi.fn();
      client.on("task.start", startSpy);
      client.on("task.complete", completeSpy);
      client.connect();

      eventHandler({ session: "sess1", event: "task.start", data: { key: "b", name: "B" } });
      eventHandler({
        session: "sess1",
        event: "task.complete",
        data: { key: "b", name: "B", result: "success" },
      });

      expect(startSpy).toHaveBeenCalledWith("b", "B", undefined);
      expect(completeSpy).toHaveBeenCalledWith("b", "B", "success", undefined);
    });

    it("routes session.destroyed", () => {
      const spy = vi.fn();
      client.on("session.destroyed", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "session.destroyed",
        data: null,
      });

      expect(spy).toHaveBeenCalled();
    });

    it("routes config.notice", () => {
      const spy = vi.fn();
      client.on("config.notice", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "config.notice",
        data: { level: "warn", message: "deprecated option" },
      });

      expect(spy).toHaveBeenCalledWith("warn", "deprecated option");
    });

    it("routes session.configReloaded", () => {
      const spy = vi.fn();
      client.on("session.configReloaded", spy);
      client.connect();

      const snapshot = wireSnapshot();
      eventHandler({
        session: "sess1",
        event: "session.configReloaded",
        data: snapshot,
      });

      expect(spy).toHaveBeenCalledWith(snapshot);
    });

    it("routes session.configStale", () => {
      const spy = vi.fn();
      client.on("session.configStale", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "session.configStale",
        data: { configStale: true },
      });

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("routes session.paneMap", () => {
      const spy = vi.fn();
      client.on("session.paneMap", spy);
      client.connect();

      eventHandler({
        session: "sess1",
        event: "session.paneMap",
        data: { paneMap: { "@tui": "%1", rainfrog: "%9" } },
      });

      expect(spy).toHaveBeenCalledWith({ "@tui": "%1", rainfrog: "%9" });
    });

    it("ignores unknown events", () => {
      client.connect();
      // Should not throw
      eventHandler({
        session: "sess1",
        event: "unknown.event",
        data: {},
      });
    });
  });
});
