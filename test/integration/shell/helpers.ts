import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

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
  fs.writeFileSync(sentinelPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinelLog}'\nexit 97\n`, {
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
    const handle = {
      child,
      result,
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

  function signalOwnedChildren(signal: NodeJS.Signals): void {
    for (const { child } of children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
      }
    }
  }

  async function cleanupOwnedResources(): Promise<void> {
    try {
      signalOwnedChildren("SIGTERM");
      await waitForCondition(
        () =>
          [...children].every(
            ({ child }) =>
              child.pid === undefined || child.exitCode !== null || child.signalCode !== null,
          ),
        2000,
      ).catch(() => {
        signalOwnedChildren("SIGKILL");
      });
      await waitForCondition(() =>
        [...children].every(
          ({ child }) =>
            child.pid === undefined || child.exitCode !== null || child.signalCode !== null,
        ),
      );
      for (const { child } of children) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      await Promise.allSettled([...children].map(async ({ result }) => result));
    } finally {
      readTmuxCalls();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
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
