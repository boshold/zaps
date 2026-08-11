import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { sessionId } from "#src/daemon/session.js";
import { MANAGED_SOCKET, managedSessionName } from "#src/lib/managed-tmux.js";

import { reservePort } from "../helpers/port.js";
import { hasBinary, hasTmux } from "../helpers/skip.js";

const execFileAsync = promisify(execFile);
const binaryPath = path.resolve("dist/zaps");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `tmux -L zaps …` — the real managed server, never the per-file test socket. */
async function managed(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["-L", MANAGED_SOCKET, ...args]);
  return stdout.trim();
}

async function managedSessionExists(name: string): Promise<boolean> {
  try {
    await managed(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run zaps as a user would from a plain terminal: no `$TMUX`, no inherited tmux
 * socket, and a private `XDG_RUNTIME_DIR` so this test drives its own daemon
 * instead of the developer's.
 */
async function runZaps(
  args: string[],
  cwd: string,
  runtimeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    ZAPS_COMMAND: binaryPath,
    ...extraEnv,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.ZAPS_TMUX_SOCKET;
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
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
interface Project {
  dir: string;
  runtimeDir: string;
  sessionName: string;
}

async function createProject(configBody: string): Promise<Project> {
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

function serviceConfig(port: number): string {
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

describe.skipIf(!hasTmux() || !hasBinary())("managed tmux create", { timeout: 120_000 }, () => {
  let project: Project | undefined = undefined;

  afterEach(async () => {
    if (project) {
      // Stop the daemon this test started, then reap its tmux session.
      await runZaps(["daemon", "stop"], project.dir, project.runtimeDir);
      try {
        await managed(["kill-session", "-t", project.sessionName]);
      } catch {
        // Already gone — the failure paths kill it themselves.
      }
      await rm(project.dir, { recursive: true, force: true });
      project = undefined;
    }
  });

  it("creates a managed session, starts services, and reports success (F4)", async () => {
    const { port, release } = await reservePort();
    project = await createProject(serviceConfig(port));
    await release();

    const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);

    expect(result.stderr + result.stdout).toContain("started (detached, managed tmux)");
    expect(result.code).toBe(0);
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(true);

    // The markers the inner zaps reads: socket routing + managed reporting.
    await expect(
      managed(["show-environment", "-t", project.sessionName, "ZAPS_TMUX_SOCKET"]),
    ).resolves.toBe(`ZAPS_TMUX_SOCKET=${MANAGED_SOCKET}`);
    await expect(
      managed(["show-environment", "-t", project.sessionName, "ZAPS_MANAGED_TMUX"]),
    ).resolves.toBe("ZAPS_MANAGED_TMUX=1");

    // Options that keep the session (and its services) alive while unattached.
    await expect(
      managed(["show-options", "-t", project.sessionName, "destroy-unattached"]),
    ).resolves.toBe("destroy-unattached off");
    const paneId = await managed([
      "list-panes",
      "-t",
      project.sessionName,
      "-F",
      "#{pane_id}",
    ]).then((out) => out.split("\n")[0]);
    await expect(managed(["show-options", "-p", "-t", paneId, "remain-on-exit"])).resolves.toBe(
      "remain-on-exit on",
    );

    // Services really run inside the managed session.
    const ready = await pollUntil(async () => {
      try {
        const response = await fetch(`http://localhost:${port}`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.status === 200;
      } catch {
        return false;
      }
    });
    expect(ready).toBe(true);

    // The daemon reports it as managed, hosted by the managed tmux session.
    const listed = await runZaps(["ls", "--json"], project.dir, project.runtimeDir);
    const sessions = JSON.parse(listed.stdout) as {
      managed: boolean;
      tmuxSession: string;
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ managed: true, tmuxSession: project.sessionName });
  });

  it("propagates an inner failure and leaves no session behind (F4)", async () => {
    project = await createProject(`export function config() {
  throw new Error("boom-managed-config");
}
`);

    const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);

    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("boom-managed-config");
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(false);
  });

  it("reaps a stale managed session the daemon knows nothing about (F9)", async () => {
    const { port, release } = await reservePort();
    project = await createProject(serviceConfig(port));
    await release();

    // Leftover from a crashed daemon: right name, no daemon session, no markers.
    await managed(["new-session", "-d", "-s", project.sessionName, "--", "sleep", "600"]);
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(true);

    const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);
    expect(result.code).toBe(0);

    // Same name, but a fresh session: the markers only exist on the new one.
    await expect(
      managed(["show-environment", "-t", project.sessionName, "ZAPS_MANAGED_TMUX"]),
    ).resolves.toBe("ZAPS_MANAGED_TMUX=1");
  });

  it("restores the legacy error under ZAPS_AUTO_TMUX=0", async () => {
    const { port, release } = await reservePort();
    project = await createProject(serviceConfig(port));
    await release();

    const result = await runZaps(["up"], project.dir, project.runtimeDir, {
      ZAPS_AUTO_TMUX: "0",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("zaps must be run from inside a tmux session.");
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(false);
  });
});
