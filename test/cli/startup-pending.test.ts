import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStartup } from "#src/cli/startup.js";
import { sessionId } from "#src/daemon/session.js";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  send: vi.fn(),
  runTui: vi.fn(),
  requestDaemon: vi.fn(),
}));

vi.mock("#src/lib/ipc/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/lib/ipc/client.js")>()),
  ipcSubscribe: mocks.subscribe,
  ipcSend: mocks.send,
}));
vi.mock("#src/cli/run-tui.js", () => ({ runTui: mocks.runTui }));
vi.mock("#src/cli/helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/cli/helpers.js")>()),
  requestDaemon: mocks.requestDaemon,
}));
vi.mock("#src/config/discovery.js", () => ({ discoverConfig: () => "/project/.zaps.mts" }));
vi.mock("#src/config/project-context.js", () => ({
  loadProjectContext: async () => ({ config: { projectDir: "/project" }, env: {} }),
}));
vi.mock("#src/daemon/lifecycle.js", () => ({
  isDaemonRunning: () => true,
  socketPath: () => "/daemon.sock",
}));

const HINT =
  "Session runs on the shell backend (created by 'zaps run'). For tmux panes: zaps down && zaps up\n";
const id = sessionId("/project/.zaps.mts", "/project");

function listed(extra: Record<string, unknown> = {}) {
  return {
    id,
    name: "project",
    configPath: "/project/.zaps.mts",
    projectDir: "/project",
    createdAt: 1,
    backend: "shell",
    capabilities: {
      panes: false,
      zoom: false,
      popups: false,
      taskPanes: false,
      rawInput: false,
      layout: false,
    },
    ...extra,
  };
}

const ttyDescriptors = new Map<
  NodeJS.ReadStream | NodeJS.WriteStream,
  PropertyDescriptor | undefined
>();

function forceTTY(): void {
  for (const stream of [process.stdin, process.stdout]) {
    ttyDescriptors.set(stream, Object.getOwnPropertyDescriptor(stream, "isTTY"));
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
}

function restoreTTY(): void {
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
  ttyDescriptors.clear();
}

describe("runStartup on an existing session", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const request = vi.fn(async () => ({ result: { started: "all" } }));

  beforeEach(() => {
    vi.clearAllMocks();
    stdout.length = 0;
    stderr.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    mocks.subscribe.mockReturnValue({
      ready: Promise.resolve(),
      subscribed: Promise.resolve(),
      request,
      close: vi.fn(),
    });
    mocks.send.mockResolvedValue(undefined);
    mocks.runTui.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreTTY();
    vi.restoreAllMocks();
  });

  function written(lines: string[]): string {
    return lines.join("");
  }

  it("zaps -b runs the deferred startup and prints the normal report once", async () => {
    mocks.requestDaemon.mockResolvedValue({ id: "l", result: [listed({ startupPending: true })] });
    await runStartup({ explicitBackend: undefined, background: true, detach: false }, undefined);
    expect(mocks.subscribe).toHaveBeenCalledWith(
      "/daemon.sock",
      id,
      expect.any(Array),
      expect.any(Object),
    );
    expect(request).toHaveBeenCalledWith("services.startAll", { startup: true }, 0);
    expect(written(stdout)).toBe(
      `Session "project" started (shell). Run 'zaps attach' to open the UI.\n`,
    );
    expect(written(stderr)).toBe(HINT);
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it("zaps up triggers the startup before opening the UI", async () => {
    forceTTY();
    mocks.requestDaemon.mockResolvedValue({ id: "l", result: [listed({ startupPending: true })] });
    const order: string[] = [];
    mocks.send.mockImplementation(async () => {
      order.push("send");
    });
    mocks.runTui.mockImplementation(async () => {
      order.push("tui");
    });
    await runStartup({ explicitBackend: undefined, background: false, detach: false }, undefined);
    expect(mocks.send).toHaveBeenCalledWith(
      "/daemon.sock",
      "services.startAll",
      { startup: true },
      id,
    );
    expect(mocks.runTui).toHaveBeenCalledWith({ sessionId: id, socketPath: "/daemon.sock" });
    expect(order).toEqual(["send", "tui"]);
    expect(written(stderr)).toBe(HINT);
  });

  it("zaps -b without the flag keeps reporting the running session", async () => {
    mocks.requestDaemon.mockResolvedValue({ id: "l", result: [listed()] });
    await runStartup({ explicitBackend: undefined, background: true, detach: false }, undefined);
    expect(written(stdout)).toBe(
      `Session "project" is already running (shell). Run 'zaps attach' to open the UI.\n`,
    );
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(written(stderr)).toBe("");
  });

  it("zaps up -B tmux on a task-only session still fails with backend_conflict", async () => {
    forceTTY();
    mocks.requestDaemon.mockResolvedValue({ id: "l", result: [listed({ startupPending: true })] });
    await expect(
      runStartup({ explicitBackend: "tmux", background: false, detach: false }, undefined),
    ).rejects.toMatchObject({ code: "backend_conflict" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
