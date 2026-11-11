import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionId } from "#src/daemon/session.js";
import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import { sessionListEntrySchema } from "#src/lib/backend/schemas.js";
import { projectedStatusSchema } from "#src/lib/backend/wire.js";

import { createShellTestEnvironment, requiredShellArtifacts, waitForCondition } from "./helpers.js";
import { requireShellPty } from "./pty-helper.js";
import { writeServiceScript } from "./store-fixture.js";

const inspection = createProcessInspection();
const sessionsSchema = z.array(sessionListEntrySchema);
const statusesSchema = z.array(projectedStatusSchema);
const logsSchema = z.array(z.string());
const pidSchema = z.coerce.number().int().positive();
const terminal = { stdin: true, stdout: true };
type Fixture = ReturnType<typeof createShellTestEnvironment>;

async function cleanup(fixture: Fixture): Promise<void> {
  try {
    if (fs.existsSync(path.join(fixture.runtimeDir, "zaps", "daemon.pid"))) {
      const stopped = await fixture.run(["daemon", "stop"]);
      expect(stopped.code, stopped.stderr).toBe(0);
      await waitForCondition(() => !fs.existsSync(fixture.socketPath));
    }
  } finally {
    try {
      await fixture.cleanup();
    } finally {
      fixture.assertNoTmux();
    }
  }
  expect(fs.existsSync(fixture.rootDir)).toBe(false);
}

function inheritedEnvironment(fixture: Fixture): Record<string, string> {
  const snapshot = path.join(fixture.rootDir, "ambient.json");
  fs.writeFileSync(snapshot, JSON.stringify({ PATH: "/unowned", HOME: "/unowned" }));
  return {
    TMUX: "/unowned/socket,1,0",
    TMUX_PANE: "%999",
    ZAPS_TMUX_SOCKET: "unowned",
    ZAPS_MANAGED_TMUX: "1",
    ZAPS_ENVIRONMENT_SNAPSHOT: snapshot,
  };
}

beforeAll(() => requireShellPty());

describe.each(requiredShellArtifacts())("$name real-terminal shell UI", ({ command }) => {
  it("keeps the same execution through launch-parent exit, q, Ctrl-C, terminal loss and reopen", async () => {
    const fixture = createShellTestEnvironment({ command, configName: ".zaps.mts" });
    const ambient = inheritedEnvironment(fixture);
    const id = sessionId(fixture.configPath, fixture.projectDir);
    const pidFile = path.join(fixture.projectDir, "worker.pid");
    const emit = path.join(fixture.projectDir, "emit");
    const worker = writeServiceScript(
      fixture,
      "worker.mjs",
      `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      console.log("PTY_WORKER_READY");
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(emit)})) {
          console.log(fs.readFileSync(${JSON.stringify(emit)}, "utf8"));
          fs.unlinkSync(${JSON.stringify(emit)});
        }
      }, 25);
    `,
    );
    fs.writeFileSync(
      fixture.configPath,
      `export function config(lib) {
      return lib.define({ name: "portable-shell-ui", services: {
        worker: { start: ${JSON.stringify(worker)}, ready: { output: /PTY_WORKER_READY/ } }
      } });
    }`,
    );
    try {
      const launch = fixture.spawn(["-b"], ambient, terminal);
      await waitForCondition(
        () => launch.child.exitCode !== null || launch.child.signalCode !== null,
      );
      const started = await launch.result;
      expect(started.code, started.stdout + started.stderr).toBe(0);
      expect(started.stdout).toContain("started (shell)");
      expect(started.stdout).not.toContain("\u001b[?1049h");
      expect(launch.child.exitCode).toBe(0);
      const daemonPid = pidSchema.parse(
        fs.readFileSync(path.join(fixture.runtimeDir, "zaps", "daemon.pid"), "utf8"),
      );
      const daemon = await fixture.ownProcessGroup(daemonPid);
      const pid = pidSchema.parse(fs.readFileSync(pidFile, "utf8"));
      const workerIdentity = await fixture.ownProcessGroup(pid);
      const sessions = await fixture.request("session.list", sessionsSchema);
      expect(sessions).toMatchObject([{ id, backend: "shell" }]);
      expect(sessions).toHaveLength(1);
      const status = await fixture.request("services.list", statusesSchema, undefined, id);
      expect(status).toMatchObject([{ name: "worker", state: "ready" }]);
      expect(
        await fixture.request("logs.snapshot", logsSchema, { service: "worker" }, id),
      ).toContain("PTY_WORKER_READY");

      async function expectRetained(marker: string): Promise<void> {
        expect(await fixture.request("session.list", sessionsSchema)).toEqual(sessions);
        const currentStatus = await fixture.request("services.list", statusesSchema, undefined, id);
        const currentLogs = await fixture.request(
          "logs.snapshot",
          logsSchema,
          { service: "worker" },
          id,
        );
        expect(currentStatus, `${marker}: ${JSON.stringify(currentLogs)}`).toEqual(status);
        const currentWorker = await inspection.readProcessIdentity(pid);
        const currentDaemon = await inspection.readProcessIdentity(daemonPid);
        expect(currentWorker && sameProcess(workerIdentity, currentWorker)).toBe(true);
        expect(currentDaemon && sameProcess(daemon, currentDaemon)).toBe(true);
        fs.writeFileSync(emit, marker);
        await waitForCondition(async () => {
          const lines = await fixture.request(
            "logs.snapshot",
            logsSchema,
            { service: "worker" },
            id,
          );
          return lines.includes(marker);
        });
      }

      for (const [index, key] of ["q", "\u0003"].entries()) {
        const ui = fixture.spawn([], ambient, terminal);
        await waitForCondition(
          () => ui.stdout.includes("portable-shell-ui") || ui.child.exitCode !== null,
        );
        expect(ui.stdout, ui.stderr).toContain("\u001b[?1049h");
        expect(ui.stdout).toContain("portable-shell-ui");
        expect(ui.stdout).toContain("shell");
        ui.child.stdin.write(key);
        await waitForCondition(() => ui.child.exitCode !== null);
        const closed = await ui.result;
        expect(closed.code, closed.stdout + closed.stderr).toBe(0);
        expect(closed.stdout).toContain("\u001b[?1049l");
        await expectRetained(`AFTER_QUIT_${index}`);
      }

      const lostTerminal = fixture.spawn([], ambient, terminal);
      await waitForCondition(() => lostTerminal.stdout.includes("portable-shell-ui"));
      const terminalProcesses = await lostTerminal.refreshOwnership();
      expect(terminalProcesses.length).toBeGreaterThan(1);
      lostTerminal.child.kill("SIGKILL");
      await waitForCondition(() => lostTerminal.child.signalCode !== null);
      await lostTerminal.result;
      await expectRetained("AFTER_TERMINAL_LOSS");
      const reopen = fixture.spawn(["attach"], ambient, terminal);
      await waitForCondition(() => reopen.stdout.includes("portable-shell-ui"));
      reopen.child.stdin.write("q");
      await waitForCondition(() => reopen.child.exitCode !== null);
      const reopened = await reopen.result;
      expect(reopened.code).toBe(0);
      await expectRetained("AFTER_FINAL_REOPEN");
      const logs = await fixture.run(["logs", "worker"], ambient);
      expect(logs.code, logs.stderr).toBe(0);
      for (const marker of [
        "PTY_WORKER_READY",
        "AFTER_QUIT_0",
        "AFTER_QUIT_1",
        "AFTER_TERMINAL_LOSS",
        "AFTER_FINAL_REOPEN",
      ]) {
        expect(logs.stdout.match(new RegExp(marker, "g"))).toHaveLength(1);
      }
    } finally {
      await cleanup(fixture);
    }
  }, 30_000);

  it.each([
    { stdin: false, stdout: true },
    { stdin: true, stdout: false },
  ])(
    "rejects UI with redirected streams $stdin/$stdout before effects; background succeeds",
    async (streams) => {
      const fixture = createShellTestEnvironment({ command, configName: ".zaps.mts" });
      const ambient = inheritedEnvironment(fixture);
      try {
        const rejected = fixture.spawn(["-B", "shell"], ambient, streams);
        await waitForCondition(
          () => rejected.child.exitCode !== null || rejected.child.signalCode !== null,
        );
        const result = await rejected.result;
        expect(result.code).toBe(1);
        const output = result.stdout + result.stderr + rejected.redirectedStdout;
        expect(output).toContain("zaps -b");
        expect(output).not.toContain("\u001b");
        expect(fs.existsSync(fixture.socketPath)).toBe(false);
        expect(fs.existsSync(path.join(fixture.runtimeDir, "zaps", "daemon.pid"))).toBe(false);
        const background = fixture.spawn(["-b"], ambient, streams);
        await waitForCondition(
          () => background.child.exitCode !== null || background.child.signalCode !== null,
        );
        const started = await background.result;
        expect(started.code, started.stdout + started.stderr).toBe(0);
        const daemonPid = pidSchema.parse(
          fs.readFileSync(path.join(fixture.runtimeDir, "zaps", "daemon.pid"), "utf8"),
        );
        await fixture.ownProcessGroup(daemonPid);
        const sessions = await fixture.request("session.list", sessionsSchema);
        expect(sessions).toMatchObject([{ backend: "shell" }]);
        const [session] = sessions;
        if (!session) {
          throw new Error("Expected background shell session");
        }
        const states = await fixture.request(
          "services.list",
          statusesSchema,
          undefined,
          session.id,
        );
        expect(states).toMatchObject([{ name: "worker", state: "ready" }]);
        const [worker] = states;
        if (worker?.pid === undefined) {
          throw new Error("Expected running worker PID");
        }
        await fixture.ownProcessGroup(worker.pid);
      } finally {
        await cleanup(fixture);
      }
    },
    20_000,
  );
});
