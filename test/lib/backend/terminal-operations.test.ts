import { execFileSync } from "node:child_process";
import { access, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
  editOperationCapture,
} from "#src/lib/backend/tmux/operations.js";
import type {
  OperationRequest,
  OperationTmux,
  TerminalOperationContext,
} from "#src/lib/backend/tmux/operations.js";
import { shellEscape } from "#src/lib/service/env.js";
import { showOutputPopup } from "#src/lib/task/output-popup.js";
import { popupPickerAvailable, runPopupPicker } from "#src/lib/task/popup-picker.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm), writeFile: vi.fn(original.writeFile) };
});

function unresolved(): never {
  throw new Error("Promise executor did not run");
}

function deferred<T>() {
  const controls: { resolve(value: T): void } = { resolve: unresolved };
  const promise = new Promise<T>((resolve) => {
    Object.assign(controls, { resolve });
  });
  return { promise, ...controls };
}

async function outcome<T>(promise: Promise<T>) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

const client = {
  name: "/dev/pts/42",
  pid: 42,
  sessionId: "$1",
  sessionName: "owned",
  windowId: "@2",
};
function fixture() {
  const popup = deferred<void>();
  const tmux = {
    detachClient: vi.fn(async (_target?: string) => undefined),
    getSocket: () => "owned-server",
    listClients: vi.fn(async () => [{ ...client }]),
    displayMessage: vi.fn(async () => "$1\towned\t@2"),
    displayPopup: vi.fn<OperationTmux["displayPopup"]>(async () => popup.promise),
    closePopup: vi.fn(async () => undefined),
    capturePaneHistory: vi.fn(async () => "  history\n\n"),
  } satisfies OperationTmux;
  const registry = new TmuxTerminalLeaseRegistry();
  const operations = new TmuxTerminalOperations(tmux, "owned", "%3", registry, 10);
  const controller = new AbortController();
  const request: OperationRequest = {
    owner: { kind: "ui", socketId: "socket-a", sessionId: "session-a" },
    cwd: "/project",
    env: { EDITOR: "my-editor --wait", PATH: "/operation/bin" },
    signal: controller.signal,
  };
  return { registry, operations, tmux, popup, controller, request };
}

async function pending(f: ReturnType<typeof fixture>) {
  const context = deferred<TerminalOperationContext>();
  const result = f.operations.run(f.request, async (operation) => {
    context.resolve(operation);
    await operation.popup({ command: "pick" });
    return "selected";
  });
  // Attach rejection handling immediately, before cancellation can win.
  const observed = outcome(result);
  await vi.waitFor(() => expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1));
  return { context: await context.promise, result, outcome: observed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal operation leases", () => {
  it.each([
    [],
    [{ ...client, sessionId: "$other", sessionName: "other" }],
    [{ ...client, windowId: "@other" }],
    [client, { ...client, name: "second", pid: 43 }],
    [client, { ...client, name: "second", pid: 43, windowId: "@other" }],
  ])("rejects missing, wrong-session/window and ambiguous clients: %j", async (...clients) => {
    const f = fixture();
    f.tmux.listClients.mockResolvedValue(clients);
    await expect(f.operations.run(f.request, async () => "unused")).rejects.toMatchObject({
      code: "backend_unavailable",
      launched: false,
    });
    expect(f.tmux.displayPopup).not.toHaveBeenCalled();
  });

  it("rejects a dashboard pane belonging to another session", async () => {
    const f = fixture();
    f.tmux.displayMessage.mockResolvedValue("$2\tother\t@2");
    await expect(f.operations.run(f.request, async () => undefined)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
  });

  it("targets client and dashboard pane with operation env/cwd", async () => {
    const f = fixture();
    const run = await pending(f);
    expect(f.tmux.displayPopup).toHaveBeenCalledWith({
      command: expect.stringContaining("popup.sh"),
      client: client.name,
      pane: "%3",
      cwd: "/project",
    });
    f.popup.resolve();
    await expect(run.result).resolves.toBe("selected");
    await expect(access(run.context.directory)).rejects.toThrow();
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
    await f.operations.dispose();
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
  });

  it("executes large captured environments and payloads through a private bounded launcher", async () => {
    const f = fixture();
    const env = {
      PATH: "/bin:/usr/bin",
      LARGE: "x".repeat(40_000),
      QUOTED: "quote'\" $HOME `id`; $(id)\nnext line",
      "non-shell-key": "preserved",
    };
    const captured = { ...env };
    let directory = "";
    f.tmux.displayPopup.mockImplementation(async (options) => {
      expect(options.env).toBeUndefined();
      expect(Buffer.byteLength(options.command)).toBeLessThan(1024);
      expect(options.command).not.toContain(env.QUOTED);
      const launcherStat = await stat(path.join(directory, "popup.sh"));
      const directoryStat = await stat(directory);
      expect(launcherStat.mode % 0o1000).toBe(0o600);
      expect(directoryStat.mode % 0o1000).toBe(0o700);
      const actual = execFileSync("/bin/sh", ["-c", options.command], {
        input: "stdin preserved\n",
        encoding: "utf8",
        env: { ...process.env, INHERITED: "tmux environment" },
      });
      expect(JSON.parse(actual)).toEqual({
        ...captured,
        INHERITED: "tmux environment",
        input: "stdin preserved\n",
      });
    });
    await f.operations.run({ ...f.request, env }, async (operation) => {
      ({ directory } = operation);
      env.LARGE = "changed after capture";
      const payload = `const fs = require("node:fs"); console.log(JSON.stringify({ PATH: process.env.PATH, LARGE: process.env.LARGE, QUOTED: process.env.QUOTED, "non-shell-key": process.env["non-shell-key"], INHERITED: process.env.INHERITED, input: fs.readFileSync(0, "utf8") }));`;
      await operation.popup({
        command: `${shellEscape(process.execPath)} -e ${shellEscape(payload)} # ${"large payload ".repeat(2000)}`,
      });
    });
    await expect(access(directory)).rejects.toThrow();
  });

  it("does not launch after cancellation during asynchronous popup preparation", async () => {
    const f = fixture();
    const prepared = deferred<void>();
    const release = deferred<void>();
    const originalWrite =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await originalWrite.writeFile(...args);
      prepared.resolve();
      await release.promise;
    });
    let directory = "";
    const result = outcome(
      f.operations.run(f.request, async (operation) => {
        ({ directory } = operation);
        await operation.popup({ command: "never" });
      }),
    );
    await prepared.promise;
    f.controller.abort();
    expect(await result).toMatchObject({ error: { code: "cancelled", launched: false } });
    release.resolve();
    await expect(access(directory)).rejects.toThrow();
    expect(f.tmux.displayPopup).not.toHaveBeenCalled();
  });

  it.each(["ui", "task"] as const)(
    "reports client loss during %s popup preparation as unavailable before launch",
    async (kind) => {
      const f = fixture();
      const prepared = deferred<void>();
      const release = deferred<void>();
      const originalWrite =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await originalWrite.writeFile(...args);
        prepared.resolve();
        await release.promise;
      });
      const owner: OperationRequest["owner"] =
        kind === "ui" ? f.request.owner : { kind: "task", sessionId: "session-a", runId: "run-a" };
      vi.useFakeTimers();
      let directory = "";
      const result = outcome(
        f.operations.run({ ...f.request, owner }, async (operation) => {
          ({ directory } = operation);
          await operation.popup({ command: "never" });
        }),
      );
      try {
        await prepared.promise;
        f.tmux.listClients.mockResolvedValue([]);
        await vi.advanceTimersByTimeAsync(10);
        expect(await result).toMatchObject({
          error: { code: "backend_unavailable", launched: false },
        });
        expect(f.tmux.displayPopup).not.toHaveBeenCalled();
        expect(f.tmux.closePopup).not.toHaveBeenCalled();
        await expect(access(directory)).rejects.toThrow();
        release.resolve();
        f.tmux.listClients.mockResolvedValue([client]);
        await expect(f.operations.run(f.request, async () => "next")).resolves.toBe("next");
      } finally {
        release.resolve();
        await f.operations.dispose();
      }
    },
  );

  it("reserves a single lease across concurrent discovery and leaves the winner open", async () => {
    const f = fixture();
    const start = async () =>
      f.operations.run(f.request, async (context) => context.popup({ command: "pick" }));
    const outcomes = [outcome(start()), outcome(start())];
    await vi.waitFor(() => expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1));
    expect(await Promise.race(outcomes)).toMatchObject({
      error: { code: "terminal_busy", launched: false },
    });
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
    f.popup.resolve();
    await Promise.all(outcomes);
  });

  it("shares client leases across managers and scopes manager disposal", async () => {
    const f = fixture();
    const run = await pending(f);
    const successor = new TmuxTerminalOperations(f.tmux, "owned", "%3", f.registry, 10);
    await expect(successor.run(f.request, async () => undefined)).rejects.toMatchObject({
      code: "terminal_busy",
    });
    await successor.dispose();
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
    f.popup.resolve();
    await run.result;
  });

  it("retains a shared lease while its client moves to another owning session", async () => {
    const f = fixture();
    const run = await pending(f);
    f.tmux.listClients.mockResolvedValue([{ ...client, sessionId: "$2", sessionName: "next" }]);
    f.tmux.displayMessage.mockResolvedValue("$2\tnext\t@2");
    const next = new TmuxTerminalOperations(f.tmux, "next", "%4", f.registry, 10);
    await expect(next.run(f.request, async () => undefined)).rejects.toMatchObject({
      code: "terminal_busy",
    });
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
  });

  it("late popup completion cannot close a replacement lease", async () => {
    const f = fixture();
    const first = await pending(f);
    await f.operations.cancelOwner(f.request.owner);
    await first.outcome;
    const secondPopup = deferred<void>();
    f.tmux.displayPopup.mockImplementation(async () => secondPopup.promise);
    const second = outcome(
      f.operations.run(f.request, async (context) => context.popup({ command: "second" })),
    );
    await vi.waitFor(() => expect(f.tmux.displayPopup).toHaveBeenCalledTimes(2));
    f.popup.resolve();
    expect(f.tmux.closePopup).toHaveBeenCalledTimes(1);
    secondPopup.resolve();
    await second;
    expect(f.tmux.closePopup).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation outcome when targeted tmux closure exits the popup nonzero", async () => {
    const f = fixture();
    let failPopup: (error: Error) => void = unresolved;
    f.tmux.displayPopup.mockImplementation(
      async () =>
        new Promise<void>((_resolve, reject) => {
          failPopup = reject;
        }),
    );
    f.tmux.closePopup.mockImplementation(async () => {
      failPopup(new Error("Popup command failed with code 1"));
    });
    const run = await pending(f);
    f.controller.abort();
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
    await expect(access(run.context.directory)).rejects.toThrow();
  });

  it("cancellation wins a simultaneous natural popup completion", async () => {
    const f = fixture();
    const run = await pending(f);
    f.controller.abort();
    f.popup.resolve();
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
  });

  it("has no ordinary RPC timeout while awaiting user input", async () => {
    const f = fixture();
    const run = await pending(f);
    vi.useFakeTimers();
    let settled = false;
    void run.outcome.then(() => {
      settled = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    f.popup.resolve();
    await run.result;
  });

  it("cancels once, cleans files, and ignores duplicate/late completion", async () => {
    const f = fixture();
    const run = await pending(f);
    f.controller.abort();
    await f.operations.cancelOwner(f.request.owner);
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
    await expect(access(run.context.directory)).rejects.toThrow();
    expect(f.tmux.closePopup).toHaveBeenCalledExactlyOnceWith(client.name);
    f.popup.resolve();
    await f.operations.dispose();
    expect(f.tmux.closePopup).toHaveBeenCalledTimes(1);
  });

  it("does not borrow or cancel a task owner's presentation for a UI socket", async () => {
    const f = fixture();
    const owner = {
      kind: "task",
      sessionId: "session-a",
      runId: "run-a",
    } satisfies OperationRequest["owner"];
    const run = await pending({ ...f, request: { ...f.request, owner } });
    await f.operations.cancelOwner(f.request.owner);
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
    await f.operations.cancelOwner(owner);
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
  });

  it.each(["client", "session", "identity", "window"])(
    "settles on %s loss without closing unrelated presentation",
    async (loss) => {
      const f = fixture();
      const run = await pending(f);
      if (loss === "session") {
        f.tmux.displayMessage.mockRejectedValue(new Error("session gone"));
      } else if (loss === "client") {
        f.tmux.listClients.mockResolvedValue([]);
      } else if (loss === "identity") {
        f.tmux.listClients.mockResolvedValue([{ ...client, pid: 99 }]);
      } else {
        f.tmux.listClients.mockResolvedValue([{ ...client, windowId: "@other" }]);
      }
      expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
      expect(f.tmux.closePopup).not.toHaveBeenCalled();
      await expect(access(run.context.directory)).rejects.toThrow();
    },
  );

  it("session destruction awaits cleanup and prevents new operations", async () => {
    const f = fixture();
    const run = await pending(f);
    await f.operations.dispose();
    await expect(access(run.context.directory)).rejects.toThrow();
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled" } });
    await expect(f.operations.run(f.request, async () => undefined)).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("revalidates immediately before launch", async () => {
    const f = fixture();
    await expect(
      f.operations.run(f.request, async (context) => {
        f.tmux.listClients.mockResolvedValue([]);
        await context.popup({ command: "pick" });
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", launched: false });
    expect(f.tmux.displayPopup).not.toHaveBeenCalled();
  });

  it("captures full raw history before the editor popup and snapshots its env", async () => {
    const f = fixture();
    const rawHistory = `${"  old history  \n".repeat(150)}\n`;
    f.tmux.capturePaneHistory.mockResolvedValue(rawHistory);
    let content = "";
    f.tmux.displayPopup.mockImplementation(async () => {
      expect(f.tmux.capturePaneHistory).toHaveBeenCalledWith("%9");
    });
    await f.operations.run(f.request, async (context) => {
      await editOperationCapture(context, "%9", "Editor");
      content = await readFile(path.join(context.directory, "capture"), "utf8");
      expect(await readFile(path.join(context.directory, "popup.sh"), "utf8")).toContain(
        "my-editor --wait",
      );
      expect(context.env).toEqual(f.request.env);
      expect(Object.isFrozen(context.env)).toBe(true);
    });
    expect(content).toBe(rawHistory);
    expect(f.tmux.displayPopup.mock.calls[0]?.[0].command).not.toContain("my-editor --wait");
    expect(f.tmux.displayPopup.mock.calls[0]?.[0].command).not.toContain("tmux capture-pane");
    await f.operations.run(
      { ...f.request, env: { EDITOR: "other", PATH: "/other/bin" } },
      async (context) => context.popup({ command: "other" }),
    );
    expect(f.tmux.displayPopup.mock.calls[1]?.[0].env).toBeUndefined();
    expect(f.request.env.EDITOR).toBe("my-editor --wait");
  });

  it("picker uses operation files and cleans on completion", async () => {
    const f = fixture();
    let directory = "";
    f.tmux.displayPopup.mockImplementation(async (options) => {
      execFileSync("sh", ["-c", options.command]);
    });
    const result = await f.operations.run(
      { ...f.request, env: { PATH: process.env.PATH ?? "/bin:/usr/bin" } },
      async (operation) => {
        ({ directory } = operation);
        return runPopupPicker([{ key: "build", name: "Build" }], {
          operation,
          buildScript: (input, output) => `cat ${shellEscape(input)} > ${shellEscape(output)}`,
        });
      },
    );
    expect(result).toBe("build");
    await expect(access(directory)).rejects.toThrow();
  });

  it("output helper uses owned file and manager cleanup after failure", async () => {
    const f = fixture();
    let directory = "";
    f.tmux.displayPopup.mockImplementation(async () => {
      throw new Error("launch failed");
    });
    await expect(
      f.operations.run(f.request, async (operation) => {
        ({ directory } = operation);
        await showOutputPopup("Output", ["  whitespace  ", ""], operation);
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", launched: true });
    await expect(access(directory)).rejects.toThrow();
  });

  it.each(["picker", "output", "editor"])("cleans %s files on owner loss", async (helper) => {
    const f = fixture();
    let directory = "";
    const result = outcome(
      f.operations.run(f.request, async (operation) => {
        ({ directory } = operation);
        if (helper === "picker") {
          await runPopupPicker([{ key: "build", name: "Build" }], { operation });
        } else if (helper === "output") {
          await showOutputPopup("Output", ["data"], operation);
        } else {
          await editOperationCapture(operation, "%9", "Editor");
        }
      }),
    );
    await vi.waitFor(() => expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1));
    const filenames: Record<string, string> = {
      picker: "tasks",
      output: "output",
      editor: "capture",
    };
    const filename = filenames[helper];
    await expect(access(path.join(directory, filename))).resolves.toBeUndefined();
    await f.operations.cancelOwner(f.request.owner);
    expect(await result).toMatchObject({ error: { code: "cancelled", launched: true } });
    await expect(access(directory)).rejects.toThrow();
  });

  it("finds fzf exclusively through the operation PATH", async () => {
    const f = fixture();
    await f.operations.run(f.request, async (operation) => {
      const executable = path.join(operation.directory, "fzf");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o700);
      const tmux = { displayPopup: vi.fn(), tmuxSupportsPopup: vi.fn(async () => true) };
      expect(await popupPickerAvailable(tmux, { PATH: operation.directory })).toBe(true);
    });
  });

  it("fzf availability uses the operation PATH", async () => {
    const tmux = { displayPopup: vi.fn(), tmuxSupportsPopup: vi.fn(async () => true) };
    expect(await popupPickerAvailable(tmux, { PATH: "/nonexistent-operation-path" })).toBe(false);
  });
});

it("quarantines a client when owned popup closure fails, forbidding fallback", async () => {
  const f = fixture();
  const run = await pending(f);
  f.tmux.closePopup.mockRejectedValue(new Error("close failed"));
  f.controller.abort();
  await expect(run.result).rejects.toMatchObject({ code: "terminal_busy" });
  await expect(
    f.operations.run({ ...f.request, signal: new AbortController().signal }, async () => undefined),
  ).rejects.toMatchObject({ code: "terminal_busy" });
  expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1);
  await expect(access(run.context.directory)).rejects.toThrow();
  f.popup.resolve();
  await vi.waitFor(async () => expect(await f.operations.assertClientAvailable()).toBeUndefined());
});

it("preserves busy and retained cleanup state when popup closure and removal both fail", async () => {
  const f = fixture();
  const run = await pending(f);
  const closeFailure = new Error("close failed");
  const removeFailure = new Error("remove failed");
  f.tmux.closePopup.mockRejectedValue(closeFailure);
  vi.mocked(rm).mockRejectedValueOnce(removeFailure);
  f.controller.abort();
  await expect(run.result).rejects.toMatchObject({
    code: "terminal_busy",
    cause: { errors: [closeFailure, removeFailure] },
  });
  await expect(access(run.context.directory)).resolves.toBeUndefined();
  await expect(f.operations.dispose()).rejects.toMatchObject({ code: "terminal_busy" });
  await expect(access(run.context.directory)).rejects.toThrow();
  f.popup.resolve();
  await vi.waitFor(async () => expect(await f.operations.dispose()).toBeUndefined());
});

it("settles the run and concurrent disposals with incomplete cleanup, then recovers after natural close", async () => {
  const f = fixture();
  const run = await pending(f);
  f.tmux.closePopup.mockRejectedValue(new Error("close failed"));
  const disposals = [outcome(f.operations.dispose()), outcome(f.operations.dispose())];
  expect(await run.outcome).toMatchObject({ error: { code: "terminal_busy" } });
  for (const disposal of disposals) {
    expect(await disposal).toMatchObject({ error: { code: "terminal_busy" } });
  }
  const successor = new TmuxTerminalOperations(f.tmux, "owned", "%3", f.registry);
  await expect(successor.assertClientAvailable()).rejects.toMatchObject({ code: "terminal_busy" });
  f.popup.resolve();
  await vi.waitFor(async () => expect(await successor.assertClientAvailable()).toBeUndefined());
  await expect(f.operations.dispose()).resolves.toBeUndefined();
  await successor.dispose();
});

it("retries retained file cleanup after natural completion", async () => {
  const f = fixture();
  const run = await pending(f);
  f.tmux.closePopup.mockRejectedValue(new Error("close failed"));
  vi.mocked(rm).mockRejectedValueOnce(new Error("remove failed"));
  f.controller.abort();
  await expect(run.result).rejects.toMatchObject({ code: "terminal_busy" });
  f.popup.resolve();
  await vi.waitFor(async () => expect(await f.operations.dispose()).toBeUndefined());
  await expect(access(run.context.directory)).rejects.toThrow();
});

it("confirms client replacement before releasing a quarantined lease", async () => {
  const f = fixture();
  const run = await pending(f);
  f.tmux.closePopup.mockRejectedValue(new Error("close failed"));
  f.controller.abort();
  await expect(run.result).rejects.toMatchObject({ code: "terminal_busy" });
  f.tmux.listClients.mockResolvedValue([{ ...client, pid: client.pid + 1 }]);
  await expect(f.operations.dispose()).resolves.toBeUndefined();
  const successor = new TmuxTerminalOperations(f.tmux, "owned", "%3", f.registry);
  await expect(successor.assertClientAvailable()).resolves.toBeUndefined();
  f.popup.resolve();
  await successor.dispose();
});

it("settles run and concurrent disposal failures while retaining files for a successful retry", async () => {
  const f = fixture();
  const run = await pending(f);
  const removal = vi.mocked(rm);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    removal.mockRejectedValueOnce(new Error("remove failed"));
  }
  const disposals = [outcome(f.operations.dispose()), outcome(f.operations.dispose())];
  expect(await run.outcome).toMatchObject({ error: { code: "backend_unavailable" } });
  for (const disposal of disposals) {
    expect(await disposal).toMatchObject({ error: { code: "backend_unavailable" } });
  }
  await expect(access(run.context.directory)).resolves.toBeUndefined();
  await expect(f.operations.dispose()).resolves.toBeUndefined();
  await expect(access(run.context.directory)).rejects.toThrow();
  f.popup.resolve();
});

describe("managed host detach", () => {
  it("closes only owned presentation, detaches explicitly, and remains reusable", async () => {
    const f = fixture();
    const run = await pending(f);
    await f.operations.detachHost(f.request.owner, () => true);
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled" } });
    expect(f.tmux.closePopup).toHaveBeenCalledExactlyOnceWith(client.name);
    expect(f.tmux.detachClient).toHaveBeenCalledExactlyOnceWith(client.name);
    f.popup.resolve();
    await expect(f.operations.run(f.request, async () => "ok")).resolves.toBe("ok");
    expect(f.tmux.closePopup).toHaveBeenCalledTimes(1);
  });

  it.each([
    [],
    [client, { ...client, name: "second", pid: 43 }],
    [{ ...client, windowId: "@other" }],
  ])("rejects absent, ambiguous or moved clients %j", async (...clients) => {
    const f = fixture();
    f.tmux.listClients.mockResolvedValue(clients);
    await expect(f.operations.detachHost(f.request.owner, () => true)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.tmux.detachClient).not.toHaveBeenCalled();
  });

  it.each(["pid", "name", "window", "session", "binding"])(
    "revalidates %s after cleanup",
    async (change) => {
      const f = fixture();
      const run = await pending(f);
      let current = true;
      f.tmux.closePopup.mockImplementation(async () => {
        if (change === "binding") {
          current = false;
        } else {
          f.tmux.listClients.mockResolvedValue([
            {
              ...client,
              ...(change === "pid" ? { pid: 99 } : {}),
              ...(change === "name" ? { name: "replacement" } : {}),
              ...(change === "window" ? { windowId: "@other" } : {}),
              ...(change === "session" ? { sessionId: "$other" } : {}),
            },
          ]);
        }
      });
      await expect(f.operations.detachHost(f.request.owner, () => current)).rejects.toMatchObject({
        code: "backend_unavailable",
      });
      expect(f.tmux.detachClient).not.toHaveBeenCalled();
      await run.outcome;
      f.popup.resolve();
    },
  );

  it("preserves quarantine when cleanup fails", async () => {
    const f = fixture();
    const run = await pending(f);
    f.tmux.closePopup.mockRejectedValue(new Error("close failed"));
    await expect(f.operations.detachHost(f.request.owner, () => true)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.tmux.detachClient).not.toHaveBeenCalled();
    await run.outcome;
    f.popup.resolve();
    await f.operations.dispose();
  });

  it("settles the same-session task popup once before detaching without replay", async () => {
    const f = fixture();
    const run = await pending({
      ...f,
      request: { ...f.request, owner: { kind: "task", runId: "run", sessionId: "session-a" } },
    });
    await f.operations.detachHost(f.request.owner, () => true);
    expect(await run.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
    expect(f.tmux.closePopup).toHaveBeenCalledExactlyOnceWith(client.name);
    expect(f.tmux.detachClient).toHaveBeenCalledExactlyOnceWith(client.name);
    expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1);
    f.popup.resolve();
    await f.operations.dispose();
    expect(f.tmux.displayPopup).toHaveBeenCalledTimes(1);
    expect(f.tmux.closePopup).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "manager"])(
    "preserves task presentation owned by another %s",
    async (scope) => {
      const f = fixture();
      const run = await pending({
        ...f,
        request: {
          ...f.request,
          owner: {
            kind: "task",
            runId: "run",
            sessionId: scope === "session" ? "other" : "session-a",
          },
        },
      });
      const detacher =
        scope === "manager"
          ? new TmuxTerminalOperations(f.tmux, "owned", "%3", f.registry)
          : f.operations;
      await expect(detacher.detachHost(f.request.owner, () => true)).rejects.toMatchObject({
        code: "backend_unavailable",
      });
      expect(f.tmux.closePopup).not.toHaveBeenCalled();
      expect(f.tmux.detachClient).not.toHaveBeenCalled();
      f.popup.resolve();
      await run.result;
    },
  );
});

it("reserves the shared client while detach cleanup awaits closure", async () => {
  const f = fixture();
  const run = await pending(f);
  const closure = deferred<void>();
  f.tmux.closePopup.mockImplementation(async () => {
    await closure.promise;
  });
  const detach = f.operations.detachHost(f.request.owner, () => true);
  await vi.waitFor(() => expect(f.tmux.closePopup).toHaveBeenCalledTimes(1));
  const successor = new TmuxTerminalOperations(f.tmux, "owned", "%3", f.registry);
  await expect(successor.run(f.request, async () => undefined)).rejects.toMatchObject({
    code: "terminal_busy",
  });
  await expect(f.operations.detachHost(f.request.owner, () => true)).rejects.toMatchObject({
    code: "backend_unavailable",
  });
  closure.resolve();
  await detach;
  await run.outcome;
  f.popup.resolve();
  expect(f.tmux.detachClient).toHaveBeenCalledTimes(1);
});

it("detaches the owning task popup without cancelling another session's lease", async () => {
  const f = fixture();
  const g = fixture();
  g.tmux.listClients.mockResolvedValue([
    {
      ...client,
      name: "/dev/pts/43",
      pid: 43,
      sessionId: "$2",
      sessionName: "other",
      windowId: "@3",
    },
  ]);
  g.tmux.displayMessage.mockResolvedValue("$2\tother\t@3");
  const other = new TmuxTerminalOperations(g.tmux, "other", "%4", f.registry);
  const unrelated = await pending({
    ...g,
    operations: other,
    request: { ...g.request, owner: { kind: "task", sessionId: "session-b", runId: "other" } },
  });
  const owned = await pending({
    ...f,
    request: { ...f.request, owner: { kind: "task", sessionId: "session-a", runId: "owned" } },
  });
  await f.operations.detachHost(f.request.owner, () => true);
  expect(await owned.outcome).toMatchObject({ error: { code: "cancelled", launched: true } });
  expect(unrelated.context.signal.aborted).toBe(false);
  expect(g.tmux.closePopup).not.toHaveBeenCalled();
  expect(g.tmux.detachClient).not.toHaveBeenCalled();
  g.popup.resolve();
  await expect(unrelated.result).resolves.toBe("selected");
  f.popup.resolve();
  await f.operations.dispose();
  await other.dispose();
});
