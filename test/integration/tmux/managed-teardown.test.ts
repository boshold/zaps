import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { getEnv } from "#src/lib/env.js";

import type { Project } from "../helpers/managed.js";
import {
  binaryPath,
  clients,
  createProject,
  managed,
  managedSessionExists,
  pollUntil,
  runZaps,
  serviceAnswers,
  serviceConfig,
} from "../helpers/managed.js";
import { reservePort } from "../helpers/port.js";
import { hasBinary, hasScriptPty, hasTmux } from "../helpers/skip.js";

const execFileAsync = promisify(execFile);

/** Started projects, torn down after each test whatever the test did to them. */
const started: { project: Project; port: number }[] = [];

async function startManaged(): Promise<{ project: Project; port: number }> {
  const { port, release } = await reservePort();
  const project = await createProject(serviceConfig(port));
  await release();
  const entry = { project, port };
  started.push(entry);
  const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);
  expect(result.code).toBe(0);
  expect(await serviceAnswers(port)).toBe(true);
  return entry;
}

describe.skipIf(!hasTmux() || !hasBinary())("managed teardown", { timeout: 180_000 }, () => {
  afterEach(async () => {
    for (const { project } of started) {
      // eslint-disable-next-line no-await-in-loop -- teardown is sequential
      await runZaps(["daemon", "stop"], project.dir, project.runtimeDir);
      try {
        // eslint-disable-next-line no-await-in-loop
        await managed(["kill-session", "-t", project.sessionName]);
      } catch {
        // Already gone — which is the point of most of these tests.
      }
    }
    started.length = 0;
  });

  it("kills the tmux session it owns and reports it (F5)", async () => {
    const { project, port } = await startManaged();

    const down = await runZaps(["down"], project.dir, project.runtimeDir);

    expect(down.code).toBe(0);
    expect(down.stdout).toContain("Session destroyed.");
    expect(down.stdout).toContain(`Killed managed tmux session ${project.sessionName}.`);
    expect(await managedSessionExists(project.sessionName)).toBe(false);
    expect(await pollUntil(async () => !(await serviceAnswers(port)), 20_000)).toBe(true);
  });

  it("leaves a sibling managed project completely alone", async () => {
    const first = await startManaged();
    const second = await startManaged();

    await runZaps(["down"], first.project.dir, first.project.runtimeDir);

    expect(await managedSessionExists(first.project.sessionName)).toBe(false);
    // Same socket, same tmux server: the sibling must not even notice.
    expect(await managedSessionExists(second.project.sessionName)).toBe(true);
    expect(await serviceAnswers(second.port)).toBe(true);

    await runZaps(["down"], second.project.dir, second.project.runtimeDir);
    expect(await managedSessionExists(second.project.sessionName)).toBe(false);
  });

  it("kills every managed session on `zaps daemon stop`", async () => {
    // One daemon, two projects: the stop path destroys each session, and each
    // Destroy takes its own tmux session with it.
    const first = await startManaged();
    const second = await createProject(
      serviceConfig(
        await reservePort().then(async (r) => {
          await r.release();
          return r.port;
        }),
      ),
    );
    started.push({ project: second, port: 0 });
    await runZaps(["up", "-d"], second.dir, first.project.runtimeDir);

    const stop = await runZaps(["daemon", "stop"], first.project.dir, first.project.runtimeDir);
    expect(stop.code).toBe(0);

    expect(await managedSessionExists(first.project.sessionName)).toBe(false);
    expect(await managedSessionExists(second.sessionName)).toBe(false);
  });

  // Guards the P03-T01 detach hint: teardown must NOT look like a detach. The
  // Daemon kills the tmux session as part of `session.destroy`, so by the time
  // The attached client dies there is no session left for the hint's probe to
  // Find — this pins that ordering instead of trusting it.
  it.skipIf(!hasScriptPty())(
    "says nothing about detaching when the session is torn down under an attached client",
    async () => {
      const { project } = await startManaged();
      const transcript = path.join(project.dir, "outer.log");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_RUNTIME_DIR: project.runtimeDir,
        ZAPS_COMMAND: binaryPath,
      };
      delete env.TMUX;
      delete env.TMUX_PANE;
      delete env.ZAPS_TMUX_SOCKET;

      // A real outer `zaps attach` over a pty: it revives the pane, attaches,
      // And is the process that would print the detach hint on its way out.
      const outer: ChildProcess = spawn("script", ["-qec", `${binaryPath} attach`, transcript], {
        cwd: project.dir,
        env,
        stdio: "ignore",
      });
      const exited = new Promise<void>((resolve) => outer.on("close", () => resolve()));
      try {
        const attached = await pollUntil(async () => {
          const live = await clients(project.sessionName);
          return live.length > 0;
        }, 30_000);
        expect(attached).toBe(true);

        const down = await runZaps(["down"], project.dir, project.runtimeDir);
        expect(down.stdout).toContain(`Killed managed tmux session ${project.sessionName}.`);

        await exited;
        const printed = fs.readFileSync(transcript, "utf8");
        expect(printed).not.toContain("detached — services still running");
        expect(await managedSessionExists(project.sessionName)).toBe(false);
      } finally {
        outer.kill("SIGKILL");
      }
    },
  );

  it.skipIf(!hasScriptPty())(
    "tears down the same way on Ctrl-D from inside the TUI, hint-free",
    async () => {
      const { project, port } = await startManaged();
      const transcript = path.join(project.dir, "outer-ctrl-d.log");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_RUNTIME_DIR: project.runtimeDir,
        ZAPS_COMMAND: binaryPath,
      };
      delete env.TMUX;
      delete env.TMUX_PANE;
      delete env.ZAPS_TMUX_SOCKET;

      const outer: ChildProcess = spawn("script", ["-qec", `${binaryPath} attach`, transcript], {
        cwd: project.dir,
        env,
        stdio: "ignore",
      });
      const exited = new Promise<void>((resolve) => outer.on("close", () => resolve()));
      try {
        expect(
          await pollUntil(async () => {
            const live = await clients(project.sessionName);
            return live.length > 0;
          }, 30_000),
        ).toBe(true);
        // Ink only reads keys once mounted — wait for the dashboard to paint.
        const tui = await managed([
          "list-panes",
          "-t",
          project.sessionName,
          "-F",
          "#{pane_id}",
        ]).then((out) => out.split("\n")[0]);
        expect(
          await pollUntil(async () => {
            const frame = await managed(["capture-pane", "-t", tui, "-p"]);
            return frame.includes("web");
          }, 30_000),
        ).toBe(true);

        await managed(["send-keys", "-t", tui, "C-d"]);

        await exited;
        const printed = fs.readFileSync(transcript, "utf8");
        expect(printed).not.toContain("detached — services still running");
        expect(await managedSessionExists(project.sessionName)).toBe(false);
        expect(await pollUntil(async () => !(await serviceAnswers(port)), 20_000)).toBe(true);
      } finally {
        outer.kill("SIGKILL");
      }
    },
  );

  it("shows the tmux location in `zaps ls`", async () => {
    const { project } = await startManaged();

    const text = await runZaps(["ls"], project.dir, project.runtimeDir);
    expect(text.stdout).toContain(`${project.sessionName} (managed)`);

    const json = await runZaps(["ls", "--json"], project.dir, project.runtimeDir);
    const sessions = JSON.parse(json.stdout) as { managed: boolean; tmuxSession: string }[];
    expect(sessions[0]).toMatchObject({ managed: true, tmuxSession: project.sessionName });
  });

  it("refuses to drive a managed session from inside another tmux (F7)", async () => {
    const { project } = await startManaged();

    // Simulate the user's own tmux: `$TMUX` set, and a different server, which
    // Is exactly the situation where pane ops would hit the wrong tmux.
    const foreignSocket = getEnv("ZAPS_TMUX_SOCKET") ?? "zaps-test";
    const inside = { TMUX: `/tmp/tmux-1000/${foreignSocket},1,0` };
    const result = await runZaps(["up"], project.dir, project.runtimeDir, inside);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is running in a zaps-managed tmux");
    // The copy-pasteable escape hatch (Q5).
    expect(result.stderr).toContain(`tmux -L zaps attach -t ${project.sessionName}`);

    const attach = await runZaps(["attach"], project.dir, project.runtimeDir, inside);
    expect(attach.code).toBe(1);
    expect(attach.stderr).toContain(`tmux -L zaps attach -t ${project.sessionName}`);
  });

  it("refuses a session hosted in the user's own tmux from a plain terminal (F6)", async () => {
    const { port, release } = await reservePort();
    const project = await createProject(serviceConfig(port));
    await release();
    started.push({ project, port });

    // A session created the pre-auto-tmux way: inside a personal tmux server.
    const personalSocket = getEnv("ZAPS_TMUX_SOCKET") ?? "zaps-test";
    const personalSession = `personal-${project.sessionName.slice(-8)}`;
    // The command IS the pane's process: `send-keys` right after `new-session`
    // Races the shell's startup and silently goes nowhere.
    // `ZAPS_TMUX_SOCKET` is what makes this a session hosted on the personal
    // Server — exactly what the pre-auto-tmux flow does via the inherited env.
    const bootCommand = `cd ${project.dir} && XDG_RUNTIME_DIR=${project.runtimeDir} ZAPS_COMMAND=${binaryPath} ZAPS_TMUX_SOCKET=${personalSocket} ${binaryPath} up -d; exec sh`;
    await execFileAsync("tmux", [
      "-L",
      personalSocket,
      "new-session",
      "-d",
      "-s",
      personalSession,
      "-x",
      "200",
      "-y",
      "50",
      "--",
      "sh",
      "-c",
      bootCommand,
    ]);
    try {
      // F6 only needs the daemon to KNOW the session; waiting for the
      // Service to be ready would test the pre-existing in-tmux flow instead.
      const registered = await pollUntil(async () => {
        const listed = await runZaps(["ls", "--json"], project.dir, project.runtimeDir);
        const sessions = JSON.parse(listed.stdout || "[]") as { managed: boolean }[];
        return sessions.length > 0;
      }, 90_000);
      expect(registered).toBe(true);

      const result = await runZaps(["up"], project.dir, project.runtimeDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `is running inside tmux session '${personalSession}'. Attach from within tmux, or run zaps down first.`,
      );
      // Nothing was spawned on the managed socket for it.
      expect(await managedSessionExists(project.sessionName)).toBe(false);
    } finally {
      await execFileAsync("tmux", [
        "-L",
        personalSocket,
        "kill-session",
        "-t",
        personalSession,
      ]).then(
        () => undefined,
        () => undefined,
      );
    }
  });
});
