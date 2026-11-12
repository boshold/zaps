import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionId } from "#src/daemon/session.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";
import {
  NO_CONFIG,
  createShellSession,
  ensureImplicitSession,
  loadLocalProject,
} from "#src/lib/session/implicit.js";

const mocks = vi.hoisted(() => ({
  discoverConfig: vi.fn<(dir: string) => string | null>(),
  request: vi.fn<(sock: string, method: string, params?: unknown) => Promise<IpcResponse>>(),
  services: { value: {} as Record<string, { start: string; raw?: boolean }> },
}));

vi.mock("#src/config/discovery.js", () => ({ discoverConfig: mocks.discoverConfig }));
vi.mock("#src/config/project-context.js", () => ({
  loadProjectContext: async () => ({
    config: { projectDir: "/project", project: { name: "p", services: mocks.services.value } },
    env: {},
  }),
}));
vi.mock("#src/lib/ipc/client.js", () => ({ ipcRequest: mocks.request }));

const shellCapabilities = {
  panes: false,
  zoom: false,
  popups: false,
  taskPanes: false,
  rawInput: false,
  layout: false,
};
const id = sessionId("/project/.zaps.mts", "/project");

function respond(responses: Record<string, IpcResponse>): void {
  mocks.request.mockImplementation(async (_sock, method) => {
    const response = responses[method];
    if (!response) {
      throw new Error(`unexpected ${method}`);
    }
    return response;
  });
}

const status: IpcResponse = {
  id: "s",
  result: { pid: 1, sessions: [], capabilities: { implicitSessions: true } },
};
const created: IpcResponse = {
  id: "c",
  result: { id, name: "p", backend: "shell", capabilities: shellCapabilities, paneMap: {} },
};

describe("ensureImplicitSession", () => {
  const ensureDaemon = vi.fn(async () => "/daemon.sock");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverConfig.mockReturnValue("/project/.zaps.mts");
    mocks.services.value = {};
  });

  it("creates an ephemeral shell session that starts nothing", async () => {
    respond({ "daemon.status": status, "session.create": created });
    await expect(ensureImplicitSession({ cwd: "/project/sub", ensureDaemon })).resolves.toEqual({
      sessionId: id,
      socketPath: "/daemon.sock",
    });
    expect(mocks.discoverConfig).toHaveBeenCalledWith("/project/sub");
    expect(mocks.request).toHaveBeenCalledWith("/daemon.sock", "session.create", {
      backend: "shell",
      configPath: "/project/.zaps.mts",
      projectDir: "/project/sub",
      resolvedProjectDir: "/project",
      startServices: false,
      ephemeral: true,
    });
  });

  it("fails without a config before touching the daemon", async () => {
    mocks.discoverConfig.mockReturnValue(null);
    await expect(ensureImplicitSession({ cwd: "/x", ensureDaemon })).rejects.toThrow(
      "No config found. Run `zaps init` to create one.",
    );
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it("rejects daemons without implicit session support", async () => {
    respond({ "daemon.status": { id: "s", result: { pid: 1, sessions: [] } } });
    await expect(ensureImplicitSession({ cwd: "/project", ensureDaemon })).rejects.toThrow(
      "The running daemon does not support running tasks without a session. Restart it when its sessions can be stopped.",
    );
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.anything(),
      "session.create",
      expect.anything(),
    );
  });

  it("maps raw-input configs to the tmux hint", async () => {
    respond({
      "daemon.status": status,
      "session.create": {
        id: "c",
        error: "Service 'ngrok' sets raw: true, but this backend does not support raw input.",
        errorCode: "unsupported_config",
      },
    });
    await expect(
      ensureImplicitSession({ cwd: "/project", ensureDaemon, task: "lint" }),
    ).rejects.toThrow(
      'Service "ngrok" uses raw input, which needs tmux. Run "zaps up" first, then "zaps run lint".',
    );
  });

  it("falls back to the config for the raw service name", async () => {
    mocks.services.value = { web: { start: "w" }, tunnel: { start: "t", raw: true } };
    respond({
      "daemon.status": status,
      "session.create": { id: "c", error: "raw input", errorCode: "unsupported_config" },
    });
    await expect(ensureImplicitSession({ cwd: "/project", ensureDaemon })).rejects.toThrow(
      'Service "tunnel" uses raw input, which needs tmux. Run "zaps up" first, then "zaps run <task>".',
    );
  });

  it("keeps other create errors with their code", async () => {
    respond({
      "daemon.status": status,
      "session.create": { id: "c", error: "closing", errorCode: "session_closing" },
    });
    await expect(ensureImplicitSession({ cwd: "/project", ensureDaemon })).rejects.toThrow(
      "session_closing: closing",
    );
  });
});

describe("createShellSession", () => {
  it("rejects a session for a different project", async () => {
    respond({
      "session.create": {
        id: "c",
        result: {
          id: "other",
          name: "p",
          backend: "shell",
          capabilities: shellCapabilities,
          paneMap: {},
        },
      },
    });
    await expect(
      createShellSession("/s", {
        configPath: "/project/.zaps.mts",
        projectDir: "/project",
        resolvedProjectDir: "/project",
      }),
    ).rejects.toThrow("Daemon returned an unexpected shell session.");
  });

  it("reports uncoded errors verbatim", async () => {
    respond({ "session.create": { id: "c", error: "boom" } });
    await expect(
      createShellSession("/s", {
        configPath: "/project/.zaps.mts",
        projectDir: "/project",
        resolvedProjectDir: "/project",
      }),
    ).rejects.toThrow(/^boom$/);
  });
});

describe("loadLocalProject", () => {
  it("loads the discovered config without a daemon", async () => {
    mocks.discoverConfig.mockReturnValue("/project/.zaps.mts");
    mocks.request.mockClear();
    await expect(loadLocalProject("/project")).resolves.toMatchObject({
      configPath: "/project/.zaps.mts",
      config: { projectDir: "/project" },
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("reports a missing config", async () => {
    mocks.discoverConfig.mockReturnValue(null);
    await expect(loadLocalProject("/x")).rejects.toThrow(NO_CONFIG);
  });
});
