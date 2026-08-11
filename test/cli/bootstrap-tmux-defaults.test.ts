import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureTmuxContext } from "../../src/cli/bootstrap-tmux.js";
import type { BootstrapDeps } from "../../src/cli/bootstrap-tmux.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  isDaemonRunning: vi.fn(),
  socketPath: () => "/tmp/zaps-bootstrap-defaults.sock",
}));
vi.mock("../../src/lib/ipc/client.js", () => ({ ipcRequest: vi.fn() }));

const { isDaemonRunning } = await import("../../src/daemon/lifecycle.js");
const { ipcRequest } = await import("../../src/lib/ipc/client.js");
const { sessionId } = await import("../../src/daemon/session.js");

const CONFIG_PATH = "/tmp/zaps-defaults/.zaps.mts";
const ID = sessionId(CONFIG_PATH);

/** Only stdio is faked: the daemon lookup under test is the real default dep. */
function io(): { deps: Partial<BootstrapDeps>; err: string[] } {
  const err: string[] = [];
  return {
    err,
    deps: {
      io: {
        stdout: () => undefined,
        stderr: (text) => err.push(text),
      },
    },
  };
}

async function run(deps: Partial<BootstrapDeps>): Promise<boolean> {
  const result = await ensureTmuxContext({
    configPath: CONFIG_PATH,
    projectDir: "/tmp/zaps-defaults",
    detach: false,
    deps,
  });
  return result.proceed;
}

beforeEach(() => {
  vi.mocked(isDaemonRunning).mockReturnValue(true);
  vi.mocked(ipcRequest).mockReset();
  // Inside tmux: the decision is made purely from the daemon's answer, so no
  // Tmux subprocess ever runs from these tests.
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ensureTmuxContext — default daemon lookup", () => {
  it("finds this project's session by id and refuses a managed one", async () => {
    vi.mocked(ipcRequest).mockResolvedValue({
      id: "1",
      result: [
        { id: "other", name: "other", projectDir: "/x", tmuxSession: "x", managed: true },
        {
          id: ID,
          name: "app",
          projectDir: "/tmp/zaps-defaults",
          tmuxSession: "zaps-app",
          managed: true,
        },
      ],
    });
    const { deps, err } = io();
    await expect(run(deps)).resolves.toBe(false);
    expect(err.join("")).toContain("zaps-managed tmux");
  });

  it("proceeds when the daemon knows no session for this project", async () => {
    vi.mocked(ipcRequest).mockResolvedValue({ id: "1", result: [] });
    await expect(run(io().deps)).resolves.toBe(true);
  });

  it("proceeds when the daemon is not running (no IPC attempted)", async () => {
    vi.mocked(isDaemonRunning).mockReturnValue(false);
    await expect(run(io().deps)).resolves.toBe(true);
    expect(ipcRequest).not.toHaveBeenCalled();
  });

  it("treats an IPC error as 'no session' rather than failing the command", async () => {
    vi.mocked(ipcRequest).mockResolvedValue({ id: "1", error: "boom" });
    await expect(run(io().deps)).resolves.toBe(true);
  });

  it("treats an unreachable daemon socket the same way", async () => {
    vi.mocked(ipcRequest).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(run(io().deps)).resolves.toBe(true);
  });
});
