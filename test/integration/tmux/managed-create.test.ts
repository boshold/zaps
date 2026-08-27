import { afterEach, describe, expect, it } from "vitest";

import { MANAGED_SOCKET } from "#src/lib/managed-tmux.js";

import type { Project } from "../helpers/managed.js";
import {
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
      managed(["show-environment", "-t", `=${project.sessionName}`, "ZAPS_MANAGED_TMUX"]),
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
