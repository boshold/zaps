import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/daemon/lifecycle.js", () => ({ socketPath: () => "/tmp/test.sock" }));
vi.mock("../../src/lib/ipc/client.js", () => ({ ipcRequest: vi.fn() }));

const { execService, wrapCommand } = await import("../../src/cli/exec-service.js");
const { spawn } = await import("node:child_process");
const { ipcRequest } = await import("../../src/lib/ipc/client.js");

interface MockChild extends EventEmitter {
  pid?: number;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(pid: number | undefined): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("wrapCommand", () => {
  it("prefixes simple commands with exec", () => {
    expect(wrapCommand("pnpm dev")).toBe("exec pnpm dev");
  });

  it("prefixes single-word commands", () => {
    expect(wrapCommand("node")).toBe("exec node");
  });

  it("prefixes commands with arguments", () => {
    expect(wrapCommand("node index.js --port 3000")).toBe("exec node index.js --port 3000");
  });

  it("does not prefix pipe commands", () => {
    expect(wrapCommand("cmd1 | cmd2")).toBe("cmd1 | cmd2");
  });

  it("does not prefix && chains", () => {
    expect(wrapCommand("cmd1 && cmd2")).toBe("cmd1 && cmd2");
  });

  it("does not prefix || chains", () => {
    expect(wrapCommand("cmd1 || cmd2")).toBe("cmd1 || cmd2");
  });

  it("does not prefix semicolon chains", () => {
    expect(wrapCommand("cmd1; cmd2")).toBe("cmd1; cmd2");
  });

  it("does not prefix backtick commands", () => {
    expect(wrapCommand("echo `date`")).toBe("echo `date`");
  });

  it("does not prefix subshell commands", () => {
    expect(wrapCommand("(cd /tmp && ls)")).toBe("(cd /tmp && ls)");
  });

  it("does not prefix background commands", () => {
    expect(wrapCommand("cmd &")).toBe("cmd &");
  });

  it("does not prefix env-assignment-prefixed commands (B1)", () => {
    expect(wrapCommand("NODE_ENV=test npm start")).toBe("NODE_ENV=test npm start");
  });

  it("tolerates leading whitespace before an env assignment", () => {
    expect(wrapCommand("  FOO=1 cmd")).toBe("  FOO=1 cmd");
  });

  it("does not prefix env-prefix combined with metacharacters", () => {
    expect(wrapCommand("FOO=bar a | b")).toBe("FOO=bar a | b");
  });

  it("still prefixes a command with a non-leading = (e.g. --opt=val)", () => {
    expect(wrapCommand("cmd --opt=val")).toBe("exec cmd --opt=val");
  });

  it("still prefixes when an env-like token is not the first token", () => {
    expect(wrapCommand("cmd FOO=bar")).toBe("exec cmd FOO=bar");
  });

  it("does not treat a digit-leading token as an env assignment", () => {
    expect(wrapCommand("1FOO=x cmd")).toBe("exec 1FOO=x cmd");
  });
});

describe("execService", () => {
  const originalExit = process.exit;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as unknown as typeof process.exit;
    onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(ipcRequest).mockResolvedValue({ id: "x", result: { ok: true } });
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  function resolveOnce(): void {
    vi.mocked(ipcRequest).mockResolvedValueOnce({
      id: "r",
      result: { command: "node app.js", cwd: "/proj", env: {} },
    });
  }

  function signalHandler(signal: string): () => void {
    const calls = onSpy.mock.calls as [string, () => void][];
    return calls.find((c) => c[0] === signal)?.[1] ?? ((): void => undefined);
  }

  function sigtermHandler(): () => void {
    return signalHandler("SIGTERM");
  }

  it("spawns the child detached", async () => {
    resolveOnce();
    vi.mocked(spawn).mockReturnValue(makeChild(111) as never);

    await execService("svc", "sess");

    expect(spawn).toHaveBeenCalledWith(
      "sh",
      ["-c", "exec node app.js"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("signals the whole process group on SIGTERM", async () => {
    resolveOnce();
    vi.mocked(spawn).mockReturnValue(makeChild(4321) as never);

    await execService("svc", "sess");
    sigtermHandler()();

    expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
  });

  it("falls back to a direct child kill when group-kill throws", async () => {
    resolveOnce();
    const child = makeChild(4321);
    vi.mocked(spawn).mockReturnValue(child as never);
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    await execService("svc", "sess");
    sigtermHandler()();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("signals the whole process group on SIGINT (daemon stops a pane with Ctrl-C)", async () => {
    resolveOnce();
    vi.mocked(spawn).mockReturnValue(makeChild(4321) as never);

    await execService("svc", "sess");
    signalHandler("SIGINT")();

    // Without a SIGINT handler the daemon's Ctrl-C would kill only this wrapper
    // And orphan the detached child, leaking its port (E11). Forward to the group.
    expect(killSpy).toHaveBeenCalledWith(-4321, "SIGINT");
  });

  it("reports a spawn error via exec-service.exited with spawnError", async () => {
    resolveOnce();
    const child = makeChild(222);
    vi.mocked(spawn).mockReturnValue(child as never);

    await execService("svc", "sess");
    child.emit("error", new Error("spawn /proj ENOENT"));
    await flush();

    expect(ipcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "exec-service.exited",
      { service: "svc", code: 127, signal: null, spawnError: "spawn /proj ENOENT" },
      1000,
      "sess",
    );
    expect(process.exit).toHaveBeenCalledWith(127);
  });

  it("reports a normal exit via exec-service.exited without spawnError", async () => {
    resolveOnce();
    const child = makeChild(333);
    vi.mocked(spawn).mockReturnValue(child as never);

    await execService("svc", "sess");
    child.emit("exit", 0, null);
    await flush();

    expect(ipcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "exec-service.exited",
      { service: "svc", code: 0, signal: null },
      1000,
      "sess",
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
