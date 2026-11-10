import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Session } from "#src/daemon/session.js";
import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { TmuxTerminalDriver } from "#src/lib/backend/tmux/driver.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { captureEnvironment, runWithEnvironment } from "#src/lib/request-context.js";
import { shellEscape } from "#src/lib/service/env.js";
import { paneExists, sendKeys, setEnv, tmuxFor } from "#src/lib/tmux.js";

import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import type { TestDaemon } from "../helpers/daemon.js";
import { hasScriptPty, hasTmux } from "../helpers/skip.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { waitFor } from "../helpers/wait.js";

const execFileAsync = promisify(execFile);
const inspection = createProcessInspection();
const sourceRoot = process.cwd();
const rawLaunch = await import("#src/lib/backend/tmux/raw-launch.js");

function nodeCommand(script: string, file: string): string {
  fs.writeFileSync(file, script);
  return `${shellEscape(process.execPath)} ${shellEscape(file)}`;
}

function runningCommand(pidFile: string, release?: string): string {
  return nodeCommand(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('started:' + process.env.LIFETIME_TOKEN); const timer = setInterval(() => { ${release ? `if (fs.existsSync(${JSON.stringify(release)})) { console.log('later:' + process.env.LIFETIME_TOKEN); clearInterval(timer); }` : ""} }, 20);`,
    `${pidFile}.cjs`,
  );
}

describe.skipIf(!hasTmux())("session task lifetimes", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let directory: string;
  let session: Session | undefined;
  let client: { cleanup: () => Promise<void> } | undefined;
  let requester: net.Socket | undefined;
  let oldCommand: string | undefined;
  let oldTerm: string | undefined;
  const identities: ProcessIdentity[] = [];
  const launchDirectories = new Set<string>();
  const configuredCalls = new Map<string, string>();

  beforeEach(async () => {
    configuredCalls.clear();
    const configuredTask = TmuxTerminalDriver.prototype.runConfiguredTask;
    vi.spyOn(TmuxTerminalDriver.prototype, "runConfiguredTask").mockImplementation(
      async function trackConfiguredTask(this: TmuxTerminalDriver, ...args) {
        const [, operation] = args;
        configuredCalls.set(operation.id, "pending");
        try {
          const result = await configuredTask.apply(this, args);
          configuredCalls.set(operation.id, result.kind);
          return result;
        } catch (error) {
          configuredCalls.set(operation.id, String(error));
          throw error;
        }
      },
    );
    const launch = rawLaunch.createRawPaneLaunch;
    vi.spyOn(rawLaunch, "createRawPaneLaunch").mockImplementation((...args) => {
      const owned = launch(...args);
      launchDirectories.add(path.dirname(owned.file));
      return owned;
    });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-task-lifetime-"));
    const executable = path.join(directory, "source-zaps");
    fs.writeFileSync(
      executable,
      `#!/bin/sh\nexec ${shellEscape(process.execPath)} --import ${shellEscape(fileURLToPath(import.meta.resolve("tsx")))} ${shellEscape(path.join(sourceRoot, "src/cli.tsx"))} "$@"\n`,
      { mode: 0o700 },
    );
    oldTerm = process.env.TERM;
    process.env.TERM = "xterm-256color";
    oldCommand = process.env.ZAPS_COMMAND;
    process.env.ZAPS_COMMAND = process.env.ZAPS_LIFETIME_EXECUTABLE ?? executable;
    expect(fs.existsSync(process.env.ZAPS_COMMAND)).toBe(true);
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    const privateSocket = testTmuxSocket();
    if (!privateSocket) {
      throw new Error("Missing owned tmux socket");
    }
    await execFileAsync("tmux", [
      "-L",
      privateSocket,
      "set-option",
      "-g",
      "default-shell",
      "/bin/sh",
    ]);
    await execFileAsync("tmux", [
      "-L",
      privateSocket,
      "set-option",
      "-g",
      "default-command",
      "exec /bin/sh",
    ]);
    await setEnv(tmux.name, "ZAPS_SOCKET_PATH", daemon.socketPath);
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    requester?.destroy();
    requester = undefined;
    await attempt(async () => session?.destroy());
    await attempt(async () => client?.cleanup());
    client = undefined;
    await attempt(async () => daemon.cleanup());
    await attempt(async () => tmux.cleanup());
    fs.rmSync(directory, { recursive: true, force: true });
    session = undefined;
    if (oldCommand === undefined) {
      delete process.env.ZAPS_COMMAND;
    } else {
      process.env.ZAPS_COMMAND = oldCommand;
    }
    if (oldTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = oldTerm;
    }
    vi.restoreAllMocks();
    for (const launchDirectory of launchDirectories) {
      try {
        expect(fs.existsSync(launchDirectory)).toBe(false);
      } catch (error) {
        failures.push(error);
      }
      fs.rmSync(launchDirectory, { recursive: true, force: true });
    }
    launchDirectories.clear();
    for (const identity of identities.splice(0)) {
      await attempt(async () => {
        const remaining = await waitFor(
          async () => inspection.readProcessIdentity(identity.pid),
          (current) => !current || !sameProcess(current, identity),
        );
        expect(remaining && sameProcess(remaining, identity)).toBeFalsy();
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, "Owned fixture cleanup incomplete");
    }
  });

  async function attachSizedClient(): Promise<{ cleanup: () => Promise<void> }> {
    const tmuxApi = tmuxFor(testTmuxSocket());
    const socket = testTmuxSocket();
    if (!socket) {
      throw new Error("Missing owned tmux socket");
    }
    const command = `stty rows 50 cols 220; exec tmux -L ${shellEscape(socket)} attach -t ${shellEscape(tmux.name)}`;
    const process = spawn("script", ["-qec", command, "/dev/null"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const clients = await waitFor(
      async () => tmuxApi.listClients(),
      (entries) => entries.length === 1,
    );
    const [attached] = clients;
    if (!attached) {
      process.kill("SIGKILL");
      throw new Error("Owned tmux client did not attach");
    }
    return {
      cleanup: async () => {
        try {
          await tmuxApi.detachClient(attached.name);
        } finally {
          process.stdin?.destroy();
          process.kill("SIGKILL");
        }
      },
    };
  }

  async function create(
    body: string,
    locale = "C.UTF-8",
    environment: Readonly<Record<string, string>> = {},
  ): Promise<Session> {
    const configPath = path.join(directory, ".zaps.mts");
    fs.writeFileSync(
      configPath,
      `import fs from 'node:fs';\nexport function config(lib) { return lib.define(${body}); }\n`,
    );
    const tmuxSocket = testTmuxSocket();
    if (!tmuxSocket) {
      throw new Error("Missing owned tmux socket");
    }
    const response = await runWithEnvironment(
      captureEnvironment({
        ...environment,
        TMPDIR: process.env.TMPDIR,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR,
        HOME: process.env.HOME,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        TERMINFO: process.env.TERMINFO,
        TERMINFO_DIRS: process.env.TERMINFO_DIRS,
        TERMCAP: process.env.TERMCAP,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color",
        LIFETIME_TOKEN: "accepted",
        ZAPS_TMUX_SOCKET: tmuxSocket,
        LANG: locale,
        LC_ALL: locale,
      }),
      async () =>
        ipcRequest(daemon.socketPath, "session.create", {
          configPath,
          projectDir: directory,
          tmuxSession: tmux.name,
          originPane: tmux.initialPaneId,
          tmuxSocket,
        }),
    );
    expect(response.error).toBeUndefined();
    const { id } = z.object({ id: z.string() }).parse(response.result);
    session = daemon.server.get(id);
    if (!session) {
      throw new Error("Session missing");
    }
    expect(session.backend.getPresentation()).toMatchObject({ tmuxSocket });
    expect(session.compatibilityProjection().originPane).toBe(tmux.initialPaneId);
    return session;
  }

  async function capture(pidFile: string): Promise<ProcessIdentity> {
    const appeared = await waitFor(async () => fs.existsSync(pidFile), Boolean, 15_000);
    if (!appeared) {
      throw new Error(
        JSON.stringify({
          pidFile,
          history: session?.taskHistory,
          output: session?.taskHistory.map((run) => session?.taskOutput.get(run.runId ?? "")),
        }),
      );
    }
    const pid = z.coerce.number().int().positive().parse(fs.readFileSync(pidFile, "utf8"));
    const identity = await inspection.readProcessIdentity(pid);
    if (!identity) {
      throw new Error(`Owned process ${pid} vanished before capture`);
    }
    identities.push(identity);
    return identity;
  }

  it("retains a disconnected public run across manager/config replacement with captured env and current helpers", async () => {
    const pidFile = path.join(directory, "background.pid");
    const servicePid = path.join(directory, "service.pid");
    const release = path.join(directory, "release");
    const command = runningCommand(pidFile, release);
    const service = `{ start: ${JSON.stringify(runningCommand(servicePid))}, detached: true, flags: { start: false }, ready: { output: /started:/ } }`;
    const current = await create(`{ name: 'lifetime', services: { api: ${service} }, tasks: {
      build: { name: 'Original', run: async (ctx) => {
        await ctx.exec(${JSON.stringify(command)});
        await lib.service.start('api');
        ctx.stdout.write('callback-tail:' + process.env.LIFETIME_TOKEN + '\\n');
      } }
    } }`);
    const oldManager = current.manager;
    const oldStart = vi.spyOn(oldManager, "startService");
    const broadcast = vi.spyOn(current, "broadcast");
    requester = net.createConnection(daemon.socketPath);
    await new Promise<void>((resolve, reject) => {
      requester?.once("connect", resolve);
      requester?.once("error", reject);
    });
    requester.write(
      `${JSON.stringify({ id: "accepted", method: "tasks.run", context: { cwd: directory, env: { ...process.env, LIFETIME_TOKEN: "accepted" } }, session: current.id, params: { key: "build" } })}\n`,
    );
    const background = await capture(pidFile);
    const runId = current.taskHistory.find((entry) => entry.taskKey === "build")?.runId;
    expect(runId).toBeTruthy();
    requester.destroy();
    requester = undefined;
    fs.writeFileSync(
      current.configPath,
      `export function config(lib) { return lib.define({ name: 'replacement', services: { api: ${service} } }); }`,
    );
    await current.reload({ ...process.env, LIFETIME_TOKEN: "replacement" });
    expect(current.manager).not.toBe(oldManager);
    expect(await inspection.readProcessIdentity(background.pid)).toMatchObject(background);
    const newStart = vi.spyOn(current.manager, "startService");
    fs.writeFileSync(release, "go");
    expect(
      await waitFor(
        async () => current.taskHistory.find((entry) => entry.runId === runId)?.result,
        (result) => result === "success",
        15_000,
      ),
    ).toBe("success");
    await capture(servicePid);
    expect(newStart).toHaveBeenCalledWith("api");
    expect(oldStart).not.toHaveBeenCalled();
    if (!runId) {
      throw new Error("Missing run ID");
    }
    expect(current.taskOutput.get(runId)?.lines).toEqual(
      expect.arrayContaining(["started:accepted", "later:accepted", "callback-tail:accepted"]),
    );
    expect(current.taskHistory.filter((entry) => entry.runId === runId)).toHaveLength(1);
    expect(
      broadcast.mock.calls.filter(
        ([event]) =>
          event.event === "task.complete" &&
          z.object({ runId: z.string() }).parse(event.data).runId === runId,
      ),
    ).toHaveLength(1);
  });

  it("keeps pane runs root-only, captures source-wrapper tail output, and owns remaining children on destroy", async () => {
    const panePid = path.join(directory, "pane.pid");
    const orphanPid = path.join(directory, "orphan.pid");
    const longCommand = nodeCommand(
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(panePid)}, String(process.pid)); const timer = setInterval(() => {}, 1000); let stopped = false; process.on('SIGINT', () => { if (!stopped) { stopped = true; console.log('destroy-tail-out'); console.error('destroy-tail-err'); clearInterval(timer); } });`,
      `${panePid}.cjs`,
    );
    const inputReady = path.join(directory, "input-ready");
    const input = nodeCommand(
      `const fs = require('node:fs'); fs.closeSync(fs.openSync('/dev/tty', 'r+')); fs.writeFileSync(${JSON.stringify(inputReady)}, 'ready'); const buffer = Buffer.alloc(100); const length = fs.readSync(0, buffer); console.log('input:' + buffer.subarray(0, length).toString().trim());`,
      path.join(directory, "input.cjs"),
    );
    const current =
      await create(`{ services: { idle: { start: 'true', detached: true, flags: { start: false } } }, tasks: {
      input: { name: 'Input', commands: ${JSON.stringify(input)} },
      dependency: { name: 'Dependency', commands: 'touch ${path.join(directory, "dependency")} ' },
      tail: { name: 'Tail', dependsOn: ['dependency'], commands: "printf 'tail-1\\ntail-2'" },
      long: { name: 'Long', commands: ${JSON.stringify(longCommand)} },
      orphan: { name: 'Orphan', commands: ${JSON.stringify(`${runningCommand(orphanPid)} & printf leader-tail`)} }
    } }`);
    const { terminal } = current.backend;
    let paneFailure: unknown;
    if (terminal) {
      const original = terminal.runTaskInPane.bind(terminal);
      vi.spyOn(terminal, "runTaskInPane").mockImplementation(async (...args) => {
        try {
          return await original(...args);
        } catch (error) {
          paneFailure = error;
          throw error;
        }
      });
    }
    const tailResponse = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "tail" },
      10_000,
      current.id,
    );
    expect(tailResponse.error, String(paneFailure)).toBeUndefined();
    const tail = z.object({ runId: z.string(), paneId: z.string() }).parse(tailResponse.result);
    expect(
      await waitFor(
        async () => current.taskOutput.get(tail.runId)?.result,
        (result) => result === "success",
        20_000,
      ),
    ).toBe("success");
    expect(current.taskOutput.get(tail.runId)?.lines).toEqual(["tail-1", "tail-2"]);
    expect(fs.existsSync(path.join(directory, "dependency"))).toBe(false);
    expect(await paneExists(tail.paneId)).toBe(true);
    const inputResponse = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "input" },
      10_000,
      current.id,
    );
    expect(inputResponse.error).toBeUndefined();
    const inputRun = z
      .object({ runId: z.string(), paneId: z.string() })
      .parse(inputResponse.result);
    expect(await waitFor(async () => fs.existsSync(inputReady), Boolean, 15_000)).toBe(true);
    await sendKeys(inputRun.paneId, "typed-value");
    expect(
      await waitFor(
        async () => current.taskOutput.get(inputRun.runId)?.result,
        (result) => result === "success",
        10_000,
      ),
    ).toBe("success");
    expect(current.taskOutput.get(inputRun.runId)?.lines).toContain("input:typed-value");
    const longResponse = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "long" },
      10_000,
      current.id,
    );
    expect(longResponse.error, String(paneFailure)).toBeUndefined();
    const long = z.object({ runId: z.string(), paneId: z.string() }).parse(longResponse.result);
    await capture(panePid);
    const orphanResponse = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "orphan" },
      10_000,
      current.id,
    );
    expect(orphanResponse.error).toBeUndefined();
    const orphan = z.object({ runId: z.string() }).parse(orphanResponse.result);
    await capture(orphanPid);
    expect(
      await waitFor(
        async () => current.taskOutput.get(orphan.runId)?.result,
        (result) => result === "error",
        10_000,
      ),
    ).toBe("error");
    const broadcast = vi.spyOn(current, "broadcast");
    await current.destroy();
    expect(current.taskOutput.get(long.runId)?.lines).toEqual(
      expect.arrayContaining(["destroy-tail-out", "destroy-tail-err"]),
    );
    expect(
      broadcast.mock.calls.filter(
        ([event]) =>
          event.event === "task.complete" &&
          z.object({ runId: z.string() }).parse(event.data).runId === long.runId,
      ),
    ).toHaveLength(1);
    expect(await paneExists(tail.paneId)).toBe(false);
    expect(await paneExists(long.paneId)).toBe(false);
  });

  it.skipIf(!hasScriptPty())(
    "completes a real configured popup with a full large captured environment",
    async () => {
      client = await attachSizedClient();
      const report = path.join(directory, "environment.json");
      const release = path.join(directory, "release-popup");
      const large = "large captured environment ".repeat(2000);
      const quoted = "quote'\" $HOME `id`; $(id)\nnext line";
      const before = new Set(fs.readdirSync(os.tmpdir()));
      const command = nodeCommand(
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ large: process.env.POPUP_LARGE, quoted: process.env.POPUP_QUOTED, token: process.env.LIFETIME_TOKEN, stdin: process.stdin.isTTY, stdout: process.stdout.isTTY })); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);`,
        path.join(directory, "popup-environment.cjs"),
      );
      const current = await create(
        `{ services: { idle: { start: "true", detached: true, flags: { start: false } } }, tasks: {
        popup: { name: 'Popup', popup: true, commands: ${JSON.stringify(command)} }
      }, hooks: { onBeforeStart: () => lib.task.run('popup') } }`,
        "C.UTF-8",
        {
          ...captureEnvironment(),
          POPUP_LARGE: large,
          POPUP_QUOTED: quoted,
        },
      );
      await waitFor(async () => fs.existsSync(report), Boolean);
      expect(JSON.parse(fs.readFileSync(report, "utf8"))).toEqual({
        large,
        quoted,
        token: "accepted",
        stdin: true,
        stdout: true,
      });
      const owned = fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith("zaps-terminal-") && !before.has(name));
      expect(owned).toHaveLength(1);
      fs.writeFileSync(release, "release");
      expect(
        await waitFor(
          async () => current.taskHistory[0]?.result,
          (result) => result === "success",
        ),
      ).toBe("success");
      expect(current.taskHistory).toHaveLength(1);
      expect(configuredCalls.get(current.taskHistory[0]?.runId ?? "")).toBe("completed");
      for (const name of owned) {
        expect(fs.existsSync(path.join(os.tmpdir(), name))).toBe(false);
      }
      await current.destroy();
    },
  );

  it.skipIf(!hasScriptPty())(
    "popup client loss fails once without replay and leaves unrelated service operations/reload available",
    async () => {
      client = await attachSizedClient();
      const popupPid = path.join(directory, "popup.pid");
      const otherPid = path.join(directory, "other.pid");
      const current = await create(`{ services: {
      other: { start: ${JSON.stringify(runningCommand(otherPid))}, detached: true, flags: { start: false }, ready: { output: /started:/ } }
    }, tasks: { popup: { name: 'Popup', popup: true, commands: ${JSON.stringify(runningCommand(popupPid))} } },
    hooks: { onBeforeStart: () => lib.task.run('popup') } }`);
      await capture(popupPid);
      const runId = current.taskHistory[0]?.runId;
      expect(runId && configuredCalls.get(runId)).toBe("pending");
      const start = await ipcRequest(
        daemon.socketPath,
        "services.start",
        { name: "other" },
        5000,
        current.id,
      );
      expect(start.error).toBeUndefined();
      await waitForServiceState(daemon.socketPath, current.id, "other", "ready");
      await capture(otherPid);
      fs.writeFileSync(
        current.configPath,
        "export function config() { throw new Error('candidate invalid'); }",
      );
      await expect(current.reload()).rejects.toThrow("candidate invalid");
      expect(current.taskHistory.find((entry) => entry.runId === runId)?.result).toBe("running");
      await client.cleanup();
      client = undefined;
      expect(
        await waitFor(
          async () => current.taskHistory.find((entry) => entry.runId === runId)?.result,
          (result) => result === "error",
          15_000,
        ),
      ).toBe("error");
      expect(current.taskHistory.filter((entry) => entry.runId === runId)).toHaveLength(1);
      fs.writeFileSync(
        current.configPath,
        "export function config(lib) { return lib.define({ services: { idle: { start: 'true', detached: true, flags: { start: false } } } }); }",
      );
      await current.reload();
      await current.destroy();
    },
  );

  it.skipIf(!hasScriptPty())(
    "reload detaches a live startup popup wait before replacing its manager",
    async () => {
      client = await attachSizedClient();
      const popupPid = path.join(directory, "reload-popup.pid");
      const current =
        await create(`{ services: { idle: { start: 'true', detached: true, flags: { start: false } } },
      tasks: { popup: { name: 'Popup', popup: true, commands: ${JSON.stringify(runningCommand(popupPid))} } },
      hooks: { onBeforeStart: () => lib.task.run('popup') } }`);
      await capture(popupPid);
      const oldManager = current.manager;
      const runId = current.taskHistory[0]?.runId;
      expect(runId && configuredCalls.get(runId)).toBe("pending");
      fs.writeFileSync(
        current.configPath,
        "export function config(lib) { return lib.define({ services: { idle: { start: 'true', detached: true, flags: { start: false } } } }); }",
      );
      await current.reload();
      expect(current.manager).not.toBe(oldManager);
      expect(
        await waitFor(
          async () => current.taskHistory.find((entry) => entry.runId === runId)?.result,
          (result) => result === "error",
        ),
      ).toBe("error");
      expect(current.taskHistory.filter((entry) => entry.runId === runId)).toHaveLength(1);
    },
  );

  it.skipIf(!hasScriptPty()).each(["C.UTF-8", "C"])(
    "destroy cancels a real startup popup and rejects later managed starts (%s)",
    async (locale) => {
      client = await attachSizedClient();
      const popupPid = path.join(directory, "destroy-popup.pid");
      const current = await create(
        `{ services: { idle: { start: 'true', detached: true, flags: { start: false } } }, tasks: {
      popup: { name: 'Popup', popup: true, commands: ${JSON.stringify(runningCommand(popupPid))} }
    }, hooks: { onBeforeStart: () => lib.task.run('popup') } }`,
        locale,
      );
      await capture(popupPid);
      const runId = current.taskHistory[0]?.runId;
      expect(runId && configuredCalls.get(runId)).toBe("pending");
      const destruction = current.destroy();
      await expect(current.taskExecution.actions.runTask("popup")).rejects.toThrow(
        "session_closing",
      );
      await destruction;
      expect(current.taskHistory[0]?.result).toBe("error");
    },
  );
});
