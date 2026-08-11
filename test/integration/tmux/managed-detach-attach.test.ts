import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { Project } from "../helpers/managed.js";
import {
  clients,
  createProject,
  managed,
  managedSessionExists,
  panes,
  pollUntil,
  runZaps,
  serviceAnswers,
  serviceConfig,
} from "../helpers/managed.js";
import { reservePort } from "../helpers/port.js";
import { hasBinary, hasScriptPty, hasTmux } from "../helpers/skip.js";

/**
 * CI has no TTY, so `attach-session` itself cannot succeed here — the exit code
 * is therefore never the assertion. What IS observable (and is what the feature
 * actually promises) is the tmux state the re-attach path leaves behind: the TUI
 * pane alive again at its original position, with the services untouched.
 *
 * `zaps up -d` leaves exactly the post-detach state: the bootstrap pane is the
 * `@tui` pane, and it is dead-but-held once the inner run exits.
 */
describe.skipIf(!hasTmux() || !hasBinary())(
  "managed detach + re-attach",
  { timeout: 180_000 },
  () => {
    let project: Project | undefined = undefined;

    afterEach(async () => {
      if (project) {
        await runZaps(["daemon", "stop"], project.dir, project.runtimeDir);
        try {
          await managed(["kill-session", "-t", `=${project.sessionName}`]);
        } catch {
          // Already gone.
        }
        project = undefined;
      }
    });

    async function startDetached(): Promise<{ port: number; tuiPane: string }> {
      const { port, release } = await reservePort();
      project = await createProject(serviceConfig(port));
      await release();
      const result = await runZaps(["up", "-d"], project.dir, project.runtimeDir);
      expect(result.code).toBe(0);
      expect(await serviceAnswers(port)).toBe(true);

      const [tui] = await panes(project.sessionName);
      // Held by `remain-on-exit`: the layout position survives the process.
      expect(tui.dead).toBe(true);
      return { port, tuiPane: tui.id };
    }

    it("revives the held TUI pane in place and keeps services running (F3)", async () => {
      const { port, tuiPane } = await startDetached();
      if (!project) {
        throw new Error("no project");
      }

      const attach = await runZaps(["attach"], project.dir, project.runtimeDir);

      const after = await panes(project.sessionName);
      const tui = after.find((p) => p.id === tuiPane);
      expect(tui).toBeDefined();
      // Same pane id — revived in place, not recreated somewhere else.
      expect(tui?.dead).toBe(false);
      // The service pane is untouched by the revival.
      expect(after.filter((p) => p.id !== tuiPane).every((p) => !p.dead)).toBe(true);
      expect(await serviceAnswers(port)).toBe(true);
      // F2 line, printed because the session outlived the (failed) client.
      expect(attach.stdout).toContain("detached — services still running");
    });

    it("survives repeated detach/re-attach cycles", async () => {
      const { port, tuiPane } = await startDetached();
      if (!project) {
        throw new Error("no project");
      }

      for (let cycle = 0; cycle < 3; cycle += 1) {
        // eslint-disable-next-line no-await-in-loop -- cycles are sequential by nature
        await runZaps(["attach"], project.dir, project.runtimeDir);
        // eslint-disable-next-line no-await-in-loop
        const livePanes = await panes(project.sessionName);
        const revived = livePanes.find((p) => p.id === tuiPane);
        expect(revived?.dead).toBe(false);

        // A hard kill of the pane's process is the crash case, and behaves like
        // A detach: `remain-on-exit` holds the pane dead at its position.
        // eslint-disable-next-line no-await-in-loop
        await managed(["send-keys", "-t", tuiPane, "C-c"]);
        process.kill(revived?.pid ?? 0, "SIGKILL");
        // eslint-disable-next-line no-await-in-loop
        const held = await pollUntil(async () => {
          const current = await panes(project?.sessionName ?? "");
          return current.find((p) => p.id === tuiPane)?.dead === true;
        }, 10_000);
        expect(held).toBe(true);
      }

      expect(await serviceAnswers(port)).toBe(true);
      expect(await managedSessionExists(project.sessionName)).toBe(true);
    });

    it("opens a new window when the TUI pane was killed outright", async () => {
      const { port, tuiPane } = await startDetached();
      if (!project) {
        throw new Error("no project");
      }

      // The user killed the pane by hand — nothing left to revive.
      await managed(["kill-pane", "-t", tuiPane]);

      const attach = await runZaps(["attach"], project.dir, project.runtimeDir);
      expect(attach.stderr).toContain("opening a new window instead");

      const windows = await managed([
        "list-windows",
        "-t",
        `=${project.sessionName}`,
        "-F",
        "#{window_id}",
      ]);
      expect(windows.split("\n").length).toBeGreaterThanOrEqual(1);
      expect(await serviceAnswers(port)).toBe(true);
    });

    // The one case that needs a real client: `q` only detaches something when
    // Something is attached, and the bug this pins (`detach-client -t <pane>`)
    // Fails silently — every pane-level assertion still passed.
    it.skipIf(!hasScriptPty())(
      "quitting with q detaches the real client and holds the pane (F2)",
      async () => {
        const { port, tuiPane } = await startDetached();
        if (!project) {
          throw new Error("no project");
        }
        const session = project.sessionName;

        // Revive the TUI so there is a live process to press `q` in.
        await runZaps(["attach"], project.dir, project.runtimeDir);
        expect(
          await pollUntil(async () => {
            const live = await panes(session);
            return live.find((p) => p.id === tuiPane)?.dead === false;
          }, 15_000),
        ).toBe(true);

        // A real tmux client over a pty — `script` is the only way to get one
        // In a headless run.
        const client: ChildProcess = spawn(
          "script",
          ["-qec", `tmux -L zaps attach -t ${session}`, "/dev/null"],
          { stdio: "ignore" },
        );
        try {
          const attached = await pollUntil(async () => {
            const live = await clients(session);
            return live.length > 0;
          }, 15_000);
          expect(attached).toBe(true);

          // Wait for the dashboard to actually paint: Ink only starts reading
          // Keys once it has mounted, and a `q` sent before that is dropped.
          expect(
            await pollUntil(async () => {
              const frame = await managed(["capture-pane", "-t", tuiPane, "-p"]);
              return frame.includes("web");
            }, 30_000),
          ).toBe(true);
          await managed(["send-keys", "-t", tuiPane, "q"]);

          // The MUST-HAVE of F2: the real client is gone, not just the process.
          const detached = await pollUntil(async () => {
            const live = await clients(session);
            return live.length === 0;
          }, 20_000);
          expect(detached).toBe(true);
          expect(
            await pollUntil(async () => {
              const live = await panes(session);
              return live.find((p) => p.id === tuiPane)?.dead === true;
            }, 20_000),
          ).toBe(true);
          // Detach, not teardown: the session and its services live on.
          expect(await managedSessionExists(session)).toBe(true);
          expect(await serviceAnswers(port)).toBe(true);
        } finally {
          client.kill("SIGKILL");
        }
      },
    );

    it("routes the bare `zaps` smart default through the same re-attach path", async () => {
      const { tuiPane } = await startDetached();
      if (!project) {
        throw new Error("no project");
      }

      await runZaps(["up"], project.dir, project.runtimeDir);

      const after = await panes(project.sessionName);
      expect(after.find((p) => p.id === tuiPane)?.dead).toBe(false);
    });
  },
);
