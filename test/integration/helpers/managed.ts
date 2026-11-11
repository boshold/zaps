import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sessionId } from "#src/daemon/session.js";
import { MANAGED_SOCKET, managedSessionName } from "#src/lib/managed-tmux.js";
import { shellEscape } from "#src/lib/service/env.js";

import { scriptPtyArgs } from "./pty.js";
import { initializeTestTmuxServer } from "./tmux-server.js";

const execFileAsync = promisify(execFile);

async function readRunResult(
  invocation: Promise<{ stdout: string; stderr: string }>,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await invocation;
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error !== "object" || error === null) {
      throw error;
    }
    return {
      code: "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
      stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

/** The native binary — the only build that behaves exactly like a user's zaps. */
export const binaryPath = path.resolve("dist/zaps");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `tmux -L zaps …` — the real managed server, never the per-file test socket. */
export async function managed(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["-L", MANAGED_SOCKET, ...args]);
  return stdout.trim();
}

export async function managedSessionExists(name: string): Promise<boolean> {
  try {
    // `=<name>`: tmux prefix-matches session targets, so a bare name would
    // Report "exists" whenever a longer-named session is around.
    await managed(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** `#{pane_dead}`-style fields for every pane of `session`, in spatial order. */
export async function panes(
  session: string,
): Promise<{ id: string; dead: boolean; pid: number; command: string }[]> {
  const out = await managed([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    "#{pane_id}|#{pane_dead}|#{pane_pid}|#{pane_current_command}",
  ]);
  if (!out) {
    return [];
  }
  return out.split("\n").map((line) => {
    const [id, dead, pid, command] = line.split("|");
    return { id, dead: dead === "1", pid: Number.parseInt(pid, 10), command };
  });
}

export async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop -- poll a real condition, never sleep-and-hope */
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

/** A project dir with a config, plus everything needed to address it later. */
export interface Project {
  dir: string;
  runtimeDir: string;
  sessionName: string;
}

export async function createProject(configBody: string): Promise<Project> {
  initializeTestTmuxServer(MANAGED_SOCKET);
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaps-managed-"));
  // Real path: macOS tmpdir is a symlink, and zaps resolves cwd before hashing.
  const realDir = fs.realpathSync(dir);
  const configPath = path.join(realDir, ".zaps.mts");
  await writeFile(configPath, configBody, "utf8");
  const runtimeDir = path.join(realDir, "run");
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    dir: realDir,
    runtimeDir,
    sessionName: managedSessionName(path.basename(realDir), sessionId(configPath, realDir)),
  };
}

/** Config with one long-lived HTTP service, used to prove services survive. */
export function serviceConfig(port: number): string {
  const start = `node -e \\"require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))\\"`;
  return `export function config({ define }) {
  return define({
    name: "managed-create",
    services: {
      web: {
        start: "${start}",
        ready: { port: ${port} },
      },
    },
  });
}
`;
}

/** TTYs of the clients attached to `session` (empty when nobody is attached). */
export async function clients(session: string): Promise<string[]> {
  try {
    // `=<name>`: without it tmux prefix-matches and lists a neighbour's clients.
    const out = await managed(["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"]);
    return out ? out.split("\n") : [];
  } catch {
    // No server / session gone → nobody is attached.
    return [];
  }
}

/**
 * Run zaps the way a user would from a plain terminal: no `$TMUX`, no inherited
 * tmux socket, and a private `XDG_RUNTIME_DIR` so the test drives its own daemon
 * instead of the developer's. Never throws — the exit code is the assertion.
 */
export async function runZaps(
  args: string[],
  cwd: string,
  runtimeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
  pty?: { detachFrom?: string; ready?: () => Promise<boolean> },
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    ZAPS_COMMAND: binaryPath,
  };
  // Plain terminal by default: strip the tmux context first, so a test that
  // Wants to simulate one can put it back via `extraEnv`.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.ZAPS_TMUX_SOCKET;
  // `zaps ls` picks toon when it thinks an agent is driving it; tests assert the
  // Human table unless they ask for a machine format explicitly.
  delete env.CLAUDECODE;
  delete env.CURSOR_TRACE_DIR;
  Object.assign(env, extraEnv);
  const command = [binaryPath, ...args].map(shellEscape).join(" ");
  if (pty) {
    Object.assign(env, { SHELL: "/bin/sh", TERM: "xterm-256color" });
  }
  const invocation = pty
    ? execFileAsync("script", scriptPtyArgs(`stty rows 50 cols 200; exec ${command}`), {
        cwd,
        env,
        timeout: 40_000,
      })
    : execFileAsync(binaryPath, args, { cwd, env });
  const result = readRunResult(invocation);
  if (pty?.detachFrom) {
    const name = pty.detachFrom;
    try {
      const attached = await pollUntil(async () => {
        const activeClients = await clients(name);
        return (
          invocation.child.exitCode !== null ||
          (activeClients.length > 0 && (pty.ready ? await pty.ready() : true))
        );
      });
      if (attached && invocation.child.exitCode === null) {
        const [client] = await clients(name);
        if (client) {
          await managed(["detach-client", "-t", client]);
        }
      }
    } catch (error) {
      invocation.child.kill();
      await result;
      throw error;
    }
  }
  return result;
}

/**
 * Print everything needed to diagnose a dead assertion from a CI log: what the
 * TUI pane shows, pane geometry/state, the daemon's view, and its log tail.
 */
export async function dumpManagedState(
  session: string,
  runtimeDir: string,
  paneId?: string,
): Promise<void> {
  // Pane id when the caller has one; `=name:` (window form) otherwise — bare
  // `=name` is not a valid capture-pane target on tmux 3.5a.
  const target = paneId ?? `=${session}:`;
  const frame = await managed(["capture-pane", "-t", target, "-p", "-S", "-100"]).catch(
    (error: unknown) => `capture failed: ${String(error)}`,
  );
  const paneTable = await managed([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    "#{pane_id}|dead=#{pane_dead}|#{pane_width}x#{pane_height}|alt=#{alternate_on}|mode=#{pane_in_mode}|#{pane_current_command}",
  ]).catch((error: unknown) => `list-panes failed: ${String(error)}`);
  const ls = await runZaps(["ls", "--json"], process.cwd(), runtimeDir);
  const logTails: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "daemon.log") {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        logTails.push(`${full}:\n${lines.slice(-30).join("\n")}`);
      }
    }
  };
  try {
    walk(runtimeDir);
  } catch (error) {
    logTails.push(`log walk failed: ${String(error)}`);
  }
  // Uses process.stderr.write, NOT console.error: the lint autofix deletes
  // Console calls, which silently guts this dump (it happened).
  process.stderr.write(
    `--- managed state dump for ${session} ---\n` +
      `panes:\n${paneTable}\n` +
      `tui frame (${target}):\n${frame}\n` +
      `zaps ls (code ${ls.code}): ${ls.stdout || ls.stderr}\n` +
      `daemon logs:\n${logTails.join("\n") || "(none found)"}\n` +
      `--- end dump ---\n`,
  );
}

/** True while the service still answers — i.e. the session survived. */
export async function serviceAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
