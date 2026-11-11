import { execFileSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TmuxTerminalDriver } from "#src/lib/backend/tmux/driver.js";
import {
  TmuxTerminalLeaseRegistry,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import { PaneCleanup } from "#src/lib/backend/tmux/pane-cleanup.js";
import type { DisplayPopupOptions } from "#src/lib/tmux.js";
import { tmuxFor } from "#src/lib/tmux.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

const rawLaunch = await import("#src/lib/backend/tmux/raw-launch.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred() {
  const controls: { resolve(): void } = {
    resolve: () => {
      throw new Error("Promise executor did not run");
    },
  };
  const promise = new Promise<void>((resolve) => {
    controls.resolve = resolve;
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

function fixture() {
  vi.spyOn(rawLaunch, "createRawPaneLaunch").mockReturnValue({
    file: "/owned/launch.sh",
    started: true,
    holder: async () => 200,
    confirm: async () => 200,
    start: async () => {
      /* Held launch mock */
    },
    release: vi.fn(),
    dispose: vi.fn(),
  });
  vi.spyOn(PaneCleanup.prototype, "registerPaneCommand").mockResolvedValue();
  vi.spyOn(PaneCleanup.prototype, "stop").mockResolvedValue(0);
  const client = { name: "owned", pid: 42, sessionId: "$1", sessionName: "host", windowId: "@2" };
  const tmux = {
    ...tmuxFor("test-only"),
    listClients: vi.fn(async () => [client]),
    displayMessage: vi.fn(async (_pane: string, format: string) =>
      format.includes("session_name") ? "$1\thost\t@2" : "$1\t@2",
    ),
    paneExists: vi.fn(async () => true),
    newWindow: vi.fn(async () => "%task"),
    splitPane: vi.fn(async () => "%split"),
    sendKeys: vi.fn(async () => undefined),
    panePid: vi.fn(async () => 0),
    killPane: vi.fn(async () => undefined),
    selectPane: vi.fn(async () => undefined),
    zoomPane: vi.fn(async () => undefined),
    tmuxSupportsPopup: vi.fn(async () => false),
    displayPopup: vi.fn(async (_options: DisplayPopupOptions) => undefined),
    closePopup: vi.fn(async () => undefined),
  };
  const operations = new TmuxTerminalOperations(
    tmux,
    "host",
    "%0",
    new TmuxTerminalLeaseRegistry(),
  );
  const driver = new TmuxTerminalDriver({
    sessionId: "session",
    sessionName: "host",
    taskPane: vi.fn(),
    tmux,
    dashboardPane: "%0",
    operations,
    paneFor: () => "%1",
    tasks: () => [],
    output: () => undefined,
    reconcile: async () => undefined,
  });
  return { driver, tmux, operations };
}

describe("semantic tmux driver", () => {
  it("owns non-popup task panes without discovering a client or UI binding", async () => {
    const f = fixture();
    f.tmux.listClients.mockResolvedValue([]);
    const handle = await f.driver.runTaskInPane(
      {
        taskKey: "build",
        runId: "run",
        execution: {
          unitId: "build",
          generation: 3,
          command: "zaps exec-task",
          cwd: "/project",
          env: {},
          placement: "default",
          raw: false,
        },
      },
      { id: "run", cwd: "/project", env: {}, signal: new AbortController().signal },
    );
    expect(handle).toMatchObject({ unitId: "build", generation: 3 });
    expect(handle.id).toBeTruthy();
    expect(f.tmux.listClients).not.toHaveBeenCalled();
    expect(f.tmux.newWindow).toHaveBeenCalledWith("host");
    expect(f.tmux.sendKeys).toHaveBeenCalledWith("%task", "sh '/owned/launch.sh'");
    await f.driver.dispose();
    expect(f.tmux.killPane).toHaveBeenCalledWith("%task");
  });

  it.each([false, true])(
    "attempts every owned group and pane despite cleanup/probe failures (%s)",
    async (probeFails) => {
      const f = fixture();
      f.tmux.newWindow.mockResolvedValueOnce("%first").mockResolvedValueOnce("%second");
      for (const runId of ["first", "second"]) {
        await f.driver.runTaskInPane(
          {
            taskKey: runId,
            runId,
            execution: {
              unitId: runId,
              generation: 1,
              command: "task",
              cwd: "/project",
              env: {},
              placement: "default",
              raw: false,
            },
          },
          { id: runId, cwd: "/project", env: {}, signal: new AbortController().signal },
        );
      }
      vi.mocked(PaneCleanup.prototype.stop).mockRejectedValueOnce(new Error("group stop failed"));
      f.tmux.killPane.mockRejectedValueOnce(new Error("pane close failed"));
      if (probeFails) {
        f.tmux.paneExists.mockRejectedValueOnce(new Error("pane probe failed"));
      }
      await expect(f.driver.dispose()).rejects.toThrow("Task pane cleanup incomplete");
      expect(PaneCleanup.prototype.stop).toHaveBeenCalledTimes(2);
      expect(f.tmux.killPane.mock.calls).toEqual([["%first"], ["%second"]]);
      await expect(f.driver.dispose()).rejects.toThrow("Task pane cleanup incomplete");
      expect(f.tmux.killPane.mock.calls.at(-1)).toEqual(["%first"]);
    },
  );

  it("validates the unique owning dashboard client for every focus/zoom", async () => {
    const f = fixture();
    await f.driver.focus({ kind: "dashboard" });
    await f.driver.zoom({ kind: "service", name: "api" });
    expect(f.tmux.listClients).toHaveBeenCalledTimes(2);
    expect(f.tmux.selectPane).toHaveBeenCalledWith("%0");
    expect(f.tmux.zoomPane).toHaveBeenCalledWith("%1");
    f.tmux.listClients.mockResolvedValue([]);
    await expect(f.driver.focus({ kind: "dashboard" })).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.tmux.selectPane).toHaveBeenCalledTimes(1);
  });

  it("rejects stale panes before effects", async () => {
    const f = fixture();
    f.tmux.paneExists.mockResolvedValue(false);
    await expect(f.driver.zoom({ kind: "service", name: "api" })).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.tmux.zoomPane).not.toHaveBeenCalled();
  });

  it("reports missing popup support after releasing owned resources", async () => {
    const f = fixture();
    const operation = {
      id: "binding",
      cwd: "/project",
      env: {},
      signal: new AbortController().signal,
    };
    await expect(f.driver.taskPicker(operation)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    await expect(f.operations.assertClientAvailable()).resolves.toBeUndefined();
    expect(f.tmux.displayPopup).not.toHaveBeenCalled();
  });
});

const configuredCommand = {
  key: "root",
  title: "Root",
  commands: ["exit 17", "exit 99"],
  width: "80%",
  height: "80%",
};
const configuredOperation = {
  id: "run",
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

it("runs configured commands using task ownership and the owning session dashboard; retains exact failure code", async () => {
  const f = fixture();
  f.tmux.tmuxSupportsPopup.mockResolvedValue(true);
  const run = vi.spyOn(f.operations, "run");
  f.tmux.displayPopup.mockImplementation(async (options) => {
    execFileSync("sh", ["-c", options.command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
  });
  expect(await f.driver.runConfiguredTask(configuredCommand, configuredOperation)).toEqual({
    kind: "completed",
    exitCode: 17,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ owner: { kind: "task", runId: "run", sessionId: "session" } }),
    expect.any(Function),
  );
  expect(f.tmux.displayPopup).toHaveBeenCalledWith(
    expect.objectContaining({ client: "owned", pane: "%0" }),
  );
});

it("returns unavailable only before launch when client or popup support is missing", async () => {
  const f = fixture();
  expect(await f.driver.runConfiguredTask(configuredCommand, configuredOperation)).toEqual({
    kind: "unavailable",
  });
  f.tmux.listClients.mockResolvedValue([]);
  expect(await f.driver.runConfiguredTask(configuredCommand, configuredOperation)).toEqual({
    kind: "unavailable",
  });
  expect(f.tmux.displayPopup).not.toHaveBeenCalled();
});

it.each(["client", "owner"] as const)(
  "falls back only for client loss, not %s cancellation during preparation",
  async (loss) => {
    const f = fixture();
    f.tmux.tmuxSupportsPopup.mockResolvedValue(true);
    const prepared = deferred();
    const release = deferred();
    const originalWrite =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let directory = "";
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      if (typeof args[0] !== "string") {
        throw new Error("Unexpected popup launcher path");
      }
      directory = path.dirname(args[0]);
      await originalWrite.writeFile(...args);
      prepared.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    const result = outcome(
      f.driver.runConfiguredTask(configuredCommand, {
        ...configuredOperation,
        signal: controller.signal,
      }),
    );
    try {
      await prepared.promise;
      if (loss === "client") {
        f.tmux.listClients.mockResolvedValue([]);
        await vi.advanceTimersByTimeAsync(250);
        expect(await result).toEqual({ value: { kind: "unavailable" } });
      } else {
        controller.abort();
        expect(await result).toMatchObject({ error: { code: "cancelled", launched: false } });
      }
      expect(f.tmux.displayPopup).not.toHaveBeenCalled();
      expect(f.tmux.closePopup).not.toHaveBeenCalled();
      await expect(access(directory)).rejects.toThrow();
    } finally {
      release.resolve();
      await f.operations.dispose();
    }
  },
);

it("fails launched commands on client loss after a side effect, without replay", async () => {
  const f = fixture();
  f.tmux.tmuxSupportsPopup.mockResolvedValue(true);
  let sideEffects = "";
  let finish: () => void = () => {
    throw new Error("Popup not started");
  };
  f.tmux.displayPopup.mockImplementation(async (options) => {
    sideEffects += execFileSync("sh", ["-c", options.command], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    });
    f.tmux.listClients.mockResolvedValue([]);
    return new Promise((resolve) => {
      finish = () => resolve(undefined);
    });
  });
  const result = f.driver.runConfiguredTask(
    { ...configuredCommand, commands: ["printf side-effect"] },
    configuredOperation,
  );
  await expect(result).rejects.toMatchObject({ launched: true });
  expect(sideEffects).toBe("side-effect");
  expect(f.tmux.displayPopup).toHaveBeenCalledOnce();
  finish();
  await f.operations.dispose();
});
