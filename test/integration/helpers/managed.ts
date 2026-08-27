import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sessionId } from "#src/daemon/session.js";
import { MANAGED_SOCKET, managedSessionName } from "#src/lib/managed-tmux.js";

const execFileAsync = promisify(execFile);

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
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
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
    sessionName: managedSessionName(path.basename(realDir), sessionId(configPath)),
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
 * Print everything needed to diagnose a dead assertion from a CI log: what the
 * TUI pane shows, the pane table, and what the daemon believes.
 */
export async function dumpManagedState(session: string, runtimeDir: string): Promise<void> {
  const frame = await managed(["capture-pane", "-t", `=${session}`, "-p", "-S", "-100"]).catch(
    (error: unknown) => `capture failed: ${String(error)}`,
  );
  const paneTable = await managed([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    "#{pane_id}|#{pane_dead}|#{pane_current_command}",
  ]).catch((error: unknown) => `list-panes failed: ${String(error)}`);
  const ls = await runZaps(["ls", "--json"], process.cwd(), runtimeDir);
  // process.stderr.write, NOT console.error: the lint autofix deletes console
  // calls, which silently guts this dump (it happened).
  process.stderr.write(
    `--- managed state dump for ${session} ---\n` +
      `panes:\n${paneTable}\n` +
      `tui frame:\n${frame}\n` +
      `zaps ls (code ${ls.code}): ${ls.stdout || ls.stderr}\n` +
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
