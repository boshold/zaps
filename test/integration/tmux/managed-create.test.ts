import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionListEntrySchema } from "#src/lib/backend/schemas.js";
import { MANAGED_SOCKET } from "#src/lib/managed-tmux.js";

import type { Project } from "../helpers/managed.js";
import {
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
import { hasBinary, hasTmux } from "../helpers/skip.js";

describe.skipIf(!hasTmux() || !hasBinary())("managed tmux create", { timeout: 120_000 }, () => {
  let project: Project | undefined = undefined;

  afterEach(async () => {
    if (project) {
      // Stop the daemon this test started, then reap its tmux session.
      await runZaps(["daemon", "stop"], project.dir, project.runtimeDir);
      try {
        await managed(["kill-session", "-t", `=${project.sessionName}`]);
      } catch {
        // Already gone — the failure paths kill it themselves.
      }
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
      managed(["show-environment", "-t", `=${project.sessionName}`, "ZAPS_TMUX_SOCKET"]),
    ).resolves.toBe(`ZAPS_TMUX_SOCKET=${MANAGED_SOCKET}`);
    await expect(
      managed(["show-environment", "-t", `=${project.sessionName}`, "ZAPS_MANAGED_TMUX"]),
    ).resolves.toBe("ZAPS_MANAGED_TMUX=1");

    // Options that keep the session (and its services) alive while unattached.
    await expect(
      managed(["show-options", "-t", `=${project.sessionName}:`, "destroy-unattached"]),
    ).resolves.toBe("destroy-unattached off");
    const paneId = await managed([
      "list-panes",
      "-t",
      `=${project.sessionName}`,
      "-F",
      "#{pane_id}",
    ]).then((out) => out.split("\n")[0]);
    await expect(managed(["show-options", "-p", "-t", paneId, "remain-on-exit"])).resolves.toBe(
      "remain-on-exit on",
    );

    const reused = await runZaps(["up", "-d"], project.dir, project.runtimeDir);
    expect(reused.code).toBe(0);
    expect(reused.stdout).toContain("already running");
    const legacy = await runZaps(["up", "-d"], project.dir, project.runtimeDir, {
      ZAPS_AUTO_TMUX: "0",
    });
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain("zaps must be run from inside a tmux session");

    const background = await runZaps(["-b"], project.dir, project.runtimeDir);
    expect(background.code).toBe(0);
    expect(background.stdout).toContain("already running (tmux)");
    const conflict = await runZaps(["-b", "-B", "shell"], project.dir, project.runtimeDir);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("backend_conflict");

    // Services really run inside the managed session.
    expect(await pollUntil(async () => serviceAnswers(port))).toBe(true);

    // The daemon reports it as managed, hosted by the managed tmux session.
    const listed = await runZaps(["ls", "--json"], project.dir, project.runtimeDir);
    const sessions = JSON.parse(listed.stdout) as {
      managed: boolean;
      tmuxSession: string;
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ managed: true, tmuxSession: project.sessionName });
  });

  it("opens new default startup in managed tmux and preserves the caller environment", async () => {
    const { port, release } = await reservePort();
    const config = serviceConfig(port).replace(
      "services: {",
      `hooks: { onBeforeStart: () => {
        if (process.env.ZAPS_TEST_BOOTSTRAP_VALUE !== "caller") {
          throw new Error("Managed bootstrap lost caller environment");
        }
      } }, services: {`,
    );
    project = await createProject(config);
    await release();

    const { runtimeDir } = project;
    const result = await runZaps(
      [],
      project.dir,
      project.runtimeDir,
      { ZAPS_TEST_BOOTSTRAP_VALUE: "caller" },
      {
        detachFrom: project.sessionName,
        ready: async () => {
          if (!(await serviceAnswers(port))) {
            return false;
          }
          return !fs
            .readdirSync(path.join(runtimeDir, "zaps"))
            .some((name) => name.startsWith("bootstrap-"));
        },
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("detached");
    expect(await serviceAnswers(port)).toBe(true);
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(true);
  });

  it("returns a foreground backend conflict and removes only the provisional managed host", async () => {
    const candidate = await createProject(`import fs from "node:fs";
      import path from "node:path";
      export async function config(lib) {
        const root = process.env.ZAPS_TEST_GATE_ROOT;
        if (root && process.env.ZAPS_MANAGED_TMUX === "1") {
          fs.writeFileSync(path.join(root, "inner-entered"), "");
          while (!fs.existsSync(path.join(root, "release-inner"))) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        return lib.define({ name: "shell-race", services: {
          worker: { start: "exit 99", flags: { start: false } }
        } });
      }`);
    project = candidate;
    const release = path.join(candidate.dir, "release-inner");
    let recover = false;
    const foreground = runZaps(
      [],
      candidate.dir,
      candidate.runtimeDir,
      { ZAPS_TEST_GATE_ROOT: candidate.dir },
      { detachFrom: candidate.sessionName, ready: async () => recover },
    );
    try {
      expect(
        await pollUntil(async () => fs.existsSync(path.join(candidate.dir, "inner-entered")), 8000),
      ).toBe(true);
      expect(await clients(candidate.sessionName)).toHaveLength(1);
      const shell = await runZaps(["-b"], candidate.dir, candidate.runtimeDir);
      expect(shell.code, shell.stderr).toBe(0);
      fs.writeFileSync(release, "");
      const result = await foreground;
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain("backend_conflict");
      expect(result.stdout).not.toContain("services still running");
      await expect(managedSessionExists(candidate.sessionName)).resolves.toBe(false);
      const listed = await runZaps(["ls", "--json"], candidate.dir, candidate.runtimeDir);
      const sessions = z.array(sessionListEntrySchema).parse(JSON.parse(listed.stdout));
      expect(sessions).toMatchObject([{ name: "shell-race", backend: "shell" }]);
    } finally {
      recover = true;
      fs.writeFileSync(release, "");
      await foreground;
    }
  });

  it("reports a detached startup hook failure and keeps the registered tmux session", async () => {
    project = await createProject(`export function config(lib) {
      return lib.define({ name: "managed-hook-failure",
        hooks: { onBeforeStart: () => { throw new Error("managed startup hook failed"); } },
        services: { worker: { start: "exit 99", flags: { start: false } } }
      });
    }`);
    const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("managed startup hook failed");
    expect(result.stdout).not.toContain("started (detached");
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(true);
    const listed = await runZaps(["ls", "--json"], project.dir, project.runtimeDir);
    const sessions = z.array(sessionListEntrySchema).parse(JSON.parse(listed.stdout));
    expect(sessions).toMatchObject([{ backend: "tmux", tmuxSession: project.sessionName }]);
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

    const result = await runZaps(["-B", "tmux", "-b"], project.dir, project.runtimeDir);
    expect(result.code).toBe(0);

    // Same name, but a fresh session: the markers only exist on the new one.
    await expect(
      managed(["show-environment", "-t", `=${project.sessionName}`, "ZAPS_MANAGED_TMUX"]),
    ).resolves.toBe("ZAPS_MANAGED_TMUX=1");
  });

  it("restores the legacy error under ZAPS_AUTO_TMUX=0", async () => {
    const { port, release } = await reservePort();
    project = await createProject(serviceConfig(port));
    await release();

    const result = await runZaps(
      ["up"],
      project.dir,
      project.runtimeDir,
      {
        ZAPS_AUTO_TMUX: "0",
      },
      {},
    );

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("zaps must be run from inside a tmux session.");
    await expect(managedSessionExists(project.sessionName)).resolves.toBe(false);
  });
});
