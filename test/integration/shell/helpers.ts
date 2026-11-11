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
import { shellEscape } from "#src/lib/service/env.js";

import { scriptPtyArgs } from "./pty-helper.js";

interface TerminalStreams {
  stdin: boolean;
  stdout: boolean;
}

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

export interface ShellArtifact {
  name: "node" | "native";
  command: ShellCommand;
}

export function requiredShellArtifacts(): ShellArtifact[] {
  const bundle = path.resolve("dist/cli.mjs");
  const native = path.resolve("dist/zaps");
  for (const artifact of [bundle, native]) {
    if (!fs.statSync(artifact).isFile()) {
      throw new Error(`Required distribution artifact is not a file: ${artifact}`);
    }
  }
  fs.accessSync(bundle, fs.constants.R_OK);
  fs.accessSync(native, fs.constants.X_OK);
  const header = Buffer.alloc(32);
  const descriptor = fs.openSync(native, "r");
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error("Native artifact header is incomplete");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const architecture = process.arch;
  let linuxMachine = 0;
  let darwinCpu = 0;
  if (architecture === "x64") {
    linuxMachine = 62;
    darwinCpu = 16_777_223;
  } else if (architecture === "arm64") {
    linuxMachine = 183;
    darwinCpu = 16_777_228;
  }
  const matchesHost =
    (process.platform === "linux" &&
      linuxMachine !== 0 &&
      header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
      header.readUInt16LE(18) === linuxMachine) ||
    (process.platform === "darwin" &&
      darwinCpu !== 0 &&
      header.readUInt32LE(0) === 4_277_009_103 &&
      header.readUInt32LE(4) === darwinCpu);
  if (!matchesHost) {
    throw new Error(`Required native artifact must match ${process.platform}/${architecture}`);
  }
  return [
    { name: "node", command: { file: process.execPath, args: [bundle] } },
    { name: "native", command: { file: native, args: [] } },
  ];
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

export function createShellTestEnvironment({
  command,
  configName = ".zaps.mjs",
}: {
  command: ShellCommand;
  configName?: string;
}) {
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
  const temporaryDirectory = os.tmpdir();
  const socketTemplate = path.join(
    temporaryDirectory,
    "zaps-shell-XXXXXX",
    "runtime",
    "daemon.sock",
  );
  const rootDir = fs.mkdtempSync(
    path.join(
      Buffer.byteLength(socketTemplate) >= 100 ? "/tmp" : temporaryDirectory,
      "zaps-shell-",
    ),
  );
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
  const configPath = path.join(projectDir, configName);
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
  const ownedProcesses = new Map<number, ProcessIdentity>();
  let cleanupPromise: Promise<void> | undefined;
  let sentinelCalls = "";

  function spawnCommand(
    args: readonly string[] = [],
    extraEnv: Record<string, string> = {},
    terminal?: TerminalStreams,
  ) {
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
    const argv = [...explicitCommand.args, ...args];
    const executable = terminal ? "script" : explicitCommand.file;
    const ptyCommand = [explicitCommand.file, ...argv].map(shellEscape).join(" ");
    const redirectedStdout = path.join(rootDir, `stdout-${children.size}.log`);
    const terminalCommand = [
      `stty rows 32 cols 100 -echo -icanon -isig; exec ${ptyCommand}`,
      terminal?.stdin ? "" : "</dev/null",
      terminal?.stdout ? "" : `>${shellEscape(redirectedStdout)}`,
    ].join(" ");
    const child = spawn(executable, terminal ? scriptPtyArgs(terminalCommand) : argv, {
      cwd: projectDir,
      env: {
        ...env,
        ...(terminal ? { SHELL: "/bin/sh", TERM: "xterm-256color" } : {}),
        ...extraEnv,
      },
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
      if (terminal && live.some((member) => member.pid === identity?.pid)) {
        for (const pid of await inspection.getDescendantTree(identity.pid)) {
          const descendant = await inspection.readProcessIdentity(pid);
          if (descendant) {
            candidates.push(descendant);
          }
        }
      }
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
      get redirectedStdout() {
        return fs.existsSync(redirectedStdout) ? fs.readFileSync(redirectedStdout, "utf8") : "";
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

  async function cleanupRecordedProcesses(): Promise<void> {
    async function live(): Promise<ProcessIdentity[]> {
      const result: ProcessIdentity[] = [];
      for (const expected of ownedProcesses.values()) {
        const actual = await inspection.readProcessIdentity(expected.pid);
        if (actual && sameProcess(expected, actual)) {
          const { stdout } = await execFileAsync("ps", [
            "-o",
            "stat=",
            "-p",
            String(actual.pid),
          ]).catch((error: unknown) => {
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
            result.push(actual);
          }
        }
      }
      return result;
    }
    for (const signal of ["SIGTERM", "SIGKILL"] satisfies NodeJS.Signals[]) {
      for (const expected of await live()) {
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
      try {
        await waitForCondition(async () => {
          const remaining = await live();
          return remaining.length === 0;
        }, 2000);
        return;
      } catch (error) {
        if (signal === "SIGKILL") {
          throw error;
        }
      }
    }
  }

  async function cleanupOwnedResources(): Promise<void> {
    const outcomes = await Promise.allSettled([
      cleanupRecordedProcesses(),
      ...[...children].map(async (handle) => cleanupChild(handle)),
    ]);
    readTmuxCalls();
    const errors: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        errors.push(outcome.reason);
      }
    }
    if (errors.length) {
      const diagnostics: ProcessIdentity[] = [...ownedProcesses.values()];
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
    async ownProcessGroup(pid: number): Promise<ProcessIdentity> {
      if (cleanupPromise) {
        throw new Error("Shell fixture already cleaned up");
      }
      const identity = await inspection.readProcessIdentity(pid);
      if (!identity || identity.pgid !== pid) {
        throw new Error(`Expected live private process group leader: ${pid}`);
      }
      ownedProcesses.set(pid, identity);
      for (const member of await inspection.getProcessMembers(identity)) {
        ownedProcesses.set(member.pid, member);
      }
      return identity;
    },
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
