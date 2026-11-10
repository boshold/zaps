import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { runWithEnvironment } from "#src/lib/request-context.js";

export interface ShellCommand {
  file: string;
  args: readonly string[];
}

export interface ShellResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop -- bounded condition polling */
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  /* eslint-enable no-await-in-loop */
}

export function createShellTestEnvironment({ command }: { command: ShellCommand }) {
  if (!path.isAbsolute(command.file)) {
    throw new Error("Explicit absolute command file required");
  }
  fs.accessSync(command.file, fs.constants.X_OK);
  if (!fs.statSync(command.file).isFile()) {
    throw new Error("Command artifact must be a file");
  }
  const explicitCommand = { file: command.file, args: [...command.args] };
  for (const argument of command.args) {
    if (path.isAbsolute(argument)) {
      fs.accessSync(argument, fs.constants.R_OK);
    }
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-shell-"));
  const projectDir = path.join(rootDir, "project");
  const runtimeDir = path.join(rootDir, "runtime");
  const homeDir = path.join(rootDir, "home");
  const sentinelDir = path.join(rootDir, "bin");
  const socketPath = path.join(runtimeDir, "daemon.sock");
  const sentinelPath = path.join(sentinelDir, "tmux");
  const sentinelLog = path.join(rootDir, "tmux.log");
  for (const directory of [projectDir, runtimeDir, homeDir, sentinelDir]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.writeFileSync(sentinelLog, "");
  const quotedLogPath = `'${sentinelLog.replaceAll("'", String.raw`'\''`)}'`;
  fs.writeFileSync(sentinelPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quotedLogPath}\nexit 97\n`, {
    mode: 0o700,
  });
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    PATH: `${sentinelDir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_STATE_HOME: path.join(homeDir, "state"),
    XDG_CONFIG_HOME: path.join(homeDir, "config"),
    TMPDIR: runtimeDir,
    ZAPS_SOCKET_PATH: socketPath,
  });
  const configPath = path.join(projectDir, ".zaps.mjs");
  const serviceCommand = `node -e "console.log('ready'); setInterval(() => {}, 1000)"`;
  fs.writeFileSync(
    configPath,
    `export function config(lib) {
    return lib.define({ name: "shell-fixture", services: {
      worker: { start: ${JSON.stringify(serviceCommand)}, ready: { output: /ready/ } }
    } });
  }\n`,
  );
  const inspection = createProcessInspection();
  const execFileAsync = promisify(execFile);
  const children = new Set<ReturnType<typeof spawnCommand>>();
  let cleanupPromise: Promise<void> | undefined;
  let sentinelCalls = "";

  function spawnCommand(args: readonly string[] = [], extraEnv: Record<string, string> = {}) {
    if (cleanupPromise) {
      throw new Error("Shell fixture already cleaned up");
    }
    for (const key of [
      "PATH",
      "HOME",
      "XDG_RUNTIME_DIR",
      "ZAPS_SOCKET_PATH",
      "TMPDIR",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
    ]) {
      if (key in extraEnv) {
        throw new Error(`Cannot override owned fixture environment: ${key}`);
      }
    }
    const child = spawn(explicitCommand.file, [...explicitCommand.args, ...args], {
      cwd: projectDir,
      env: { ...env, ...extraEnv },
      stdio: "pipe",
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    const result = new Promise<ShellResult>((resolve, reject) => {
      child.on("close", (code, signal) => {
        if (spawnError) {
          reject(spawnError);
        } else {
          resolve({ code, signal, stdout, stderr });
        }
      });
    });
    void result.catch(() => {
      // Observed by callers and cleanup.
    });
    const members = new Map<number, ProcessIdentity>();
    let identity: ProcessIdentity | null = null;
    let monitor: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function refreshOwnership(): Promise<ProcessIdentity[]> {
      if (!identity) {
        if (child.pid === undefined) {
          return [];
        }
        const captured =
          child.exitCode === null && child.signalCode === null
            ? await inspection.readProcessIdentity(child.pid)
            : null;
        identity = child.exitCode === null && child.signalCode === null ? captured : null;
        if (!identity) {
          const { stdout: groupOutput } = await execFileAsync("ps", ["-axo", "pgid="], {
            timeout: 1000,
          });
          const groups = z
            .array(z.coerce.number().int().nonnegative())
            .parse(groupOutput.trim().split(/\s+/));
          if (!groups.includes(child.pid)) {
            return [];
          }
          throw new Error(`Unverified surviving fixture group: ${child.pid}`);
        }
        if (identity.pgid !== child.pid) {
          throw new Error(`Invalid fixture process group: ${child.pid}`);
        }
        members.set(identity.pid, identity);
      }
      const live: ProcessIdentity[] = [];
      for (const member of members.values()) {
        const actual = await inspection.readProcessIdentity(member.pid);
        if (actual && sameProcess(member, actual)) {
          live.push(actual);
        }
      }
      const candidates = await inspection.getProcessMembers(identity);
      const [anchor] = live;
      if (anchor) {
        for (const member of candidates) {
          members.set(member.pid, member);
        }
      } else if (candidates.some((candidate) => !members.has(candidate.pid))) {
        throw new Error(`Unverified fixture descendants: ${JSON.stringify(candidates)}`);
      }
      return [...members.values()];
    }
    let tracking = Promise.resolve();
    async function track(): Promise<void> {
      try {
        await refreshOwnership();
      } catch {
        // Cleanup retries ownership probes and surfaces unresolved failures.
      } finally {
        if (!stopped) {
          monitor = setTimeout(() => {
            tracking = track();
          }, 10);
        }
      }
    }
    tracking = track();
    const handle = {
      child,
      result,
      members,
      refreshOwnership,
      async stopTracking() {
        stopped = true;
        clearTimeout(monitor);
        await tracking;
      },
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    };
    children.add(handle);
    return handle;
  }

  function readTmuxCalls(): string {
    if (fs.existsSync(sentinelLog)) {
      sentinelCalls = fs.readFileSync(sentinelLog, "utf8");
    }
    return sentinelCalls;
  }

  function assertNoTmux(): void {
    const calls = readTmuxCalls();
    if (calls) {
      throw new Error(`Unexpected tmux invocation: ${calls}`);
    }
  }

  async function liveOwnedMembers(
    handle: ReturnType<typeof spawnCommand>,
  ): Promise<ProcessIdentity[]> {
    const live: ProcessIdentity[] = [];
    for (const expected of await handle.refreshOwnership()) {
      const actual = await inspection.readProcessIdentity(expected.pid);
      if (actual && sameProcess(expected, actual)) {
        const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(expected.pid)], {
          timeout: 1000,
        }).catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === 1 &&
            "stdout" in error &&
            error.stdout === ""
          ) {
            return { stdout: "" };
          }
          throw error;
        });
        if (stdout.trim() && !stdout.trim().startsWith("Z")) {
          live.push(actual);
        }
      }
    }
    return live;
  }

  async function signalOwnedChildren(
    handle: ReturnType<typeof spawnCommand>,
    signal: NodeJS.Signals,
  ): Promise<void> {
    for (const expected of await liveOwnedMembers(handle)) {
      const actual = await inspection.readProcessIdentity(expected.pid);
      if (actual && sameProcess(expected, actual)) {
        try {
          process.kill(expected.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
      }
    }
  }

  async function cleanupChild(handle: ReturnType<typeof spawnCommand>): Promise<void> {
    await handle.stopTracking();
    async function stopped(): Promise<boolean> {
      const live = await liveOwnedMembers(handle);
      return live.length === 0;
    }
    await signalOwnedChildren(handle, "SIGTERM");
    await waitForCondition(stopped, 2000).catch(async () => {
      await signalOwnedChildren(handle, "SIGKILL");
    });
    await waitForCondition(stopped, 2000);
    handle.child.stdin.destroy();
    handle.child.stdout.destroy();
    handle.child.stderr.destroy();
    await handle.result.catch(() => {
      // Spawn failures remain observable through result.
    });
  }

  async function cleanupOwnedResources(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...children].map(async (handle) => cleanupChild(handle)),
    );
    readTmuxCalls();
    const errors: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        errors.push(outcome.reason);
      }
    }
    if (errors.length) {
      const diagnostics: ProcessIdentity[] = [];
      for (const handle of children) {
        for (const member of handle.members.values()) {
          diagnostics.push(member);
        }
      }
      fs.writeFileSync(
        path.join(rootDir, "cleanup-error.txt"),
        `${errors.map(String).join("\n")}\n${JSON.stringify(diagnostics)}`,
      );
      throw new AggregateError(errors, `Fixture cleanup incomplete: ${rootDir}`);
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }

  return {
    rootDir,
    projectDir,
    runtimeDir,
    homeDir,
    socketPath,
    sentinelPath,
    sentinelLog,
    configPath,
    env: Object.freeze(env),
    spawn: spawnCommand,
    async run(args: readonly string[] = [], extraEnv: Record<string, string> = {}) {
      return spawnCommand(args, extraEnv).result;
    },
    async request<T>(
      method: string,
      schema: z.ZodType<T>,
      params?: unknown,
      session?: string,
    ): Promise<T> {
      const response = await runWithEnvironment(env, async () =>
        ipcRequest(socketPath, method, params, 5000, session),
      );
      if (response.error !== undefined) {
        throw new Error(response.error);
      }
      return schema.parse(response.result);
    },
    async waitForSocket() {
      return waitForCondition(
        () => fs.existsSync(socketPath) && fs.statSync(socketPath).isSocket(),
      );
    },
    readTmuxCalls,
    assertNoTmux,
    async cleanup(): Promise<void> {
      cleanupPromise ??= cleanupOwnedResources();
      return cleanupPromise;
    },
  };
}
