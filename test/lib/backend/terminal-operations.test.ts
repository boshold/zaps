import { execFileSync } from "node:child_process";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
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
      command: "pick",
      client: client.name,
      pane: "%3",
      cwd: "/project",
      env: { EDITOR: "my-editor --wait", PATH: "/operation/bin" },
    });
    f.popup.resolve();
    await expect(run.result).resolves.toBe("selected");
    await expect(access(run.context.directory)).rejects.toThrow();
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
    await f.operations.dispose();
    expect(f.tmux.closePopup).not.toHaveBeenCalled();
  });

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
      expect(context.env).toEqual(f.request.env);
      expect(Object.isFrozen(context.env)).toBe(true);
    });
    expect(content).toBe(rawHistory);
    expect(f.tmux.displayPopup.mock.calls[0]?.[0].command).toContain("my-editor --wait");
    expect(f.tmux.displayPopup.mock.calls[0]?.[0].command).not.toContain("tmux capture-pane");
    await f.operations.run(
      { ...f.request, env: { EDITOR: "other", PATH: "/other/bin" } },
      async (context) => context.popup({ command: "other" }),
    );
    expect(f.tmux.displayPopup.mock.calls[1]?.[0].env).toEqual({
      EDITOR: "other",
      PATH: "/other/bin",
    });
    expect(f.request.env.EDITOR).toBe("my-editor --wait");
  });

  it("picker uses operation files and cleans on completion", async () => {
    const f = fixture();
    let directory = "";
    f.tmux.displayPopup.mockImplementation(async (options) => {
      execFileSync("sh", ["-c", options.command]);
    });
    const result = await f.operations.run(f.request, async (operation) => {
      ({ directory } = operation);
      return runPopupPicker([{ key: "build", name: "Build" }], {
        operation,
        buildScript: (input, output) => `cat ${shellEscape(input)} > ${shellEscape(output)}`,
      });
    });
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
