import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionId } from "#src/daemon/session.js";
import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import { sessionListEntrySchema } from "#src/lib/backend/schemas.js";
import { daemonStatusSchema, projectedStatusSchema } from "#src/lib/backend/wire.js";

import { createShellTestEnvironment, requiredShellArtifacts, waitForCondition } from "./helpers.js";
import { writeServiceScript } from "./store-fixture.js";

const inspection = createProcessInspection();
const listSchema = z.array(sessionListEntrySchema);
const statusSchema = z.array(projectedStatusSchema);
const pidSchema = z.coerce.number().int().positive();

describe.each(requiredShellArtifacts())("$name distribution shell lifecycle", ({ command }) => {
  it("retains ownership and logs across requester exit, reconnect, reuse and restart", async () => {
    const fixture = createShellTestEnvironment({ command, configName: ".zaps.mts" });
    const id = sessionId(fixture.configPath, fixture.projectDir);
    const daemonPidFile = path.join(fixture.runtimeDir, "zaps", "daemon.pid");
    const release = path.join(fixture.projectDir, "release");
    const emit = path.join(fixture.projectDir, "emit");
    const workerPidFile = path.join(fixture.projectDir, "worker.pid");
    const siblingPidFile = path.join(fixture.projectDir, "sibling.pid");
    const snapshot = path.join(fixture.rootDir, "ambient.json");
    const snapshotContents = JSON.stringify({ PATH: "/unowned", XDG_RUNTIME_DIR: "/unowned" });
    fs.writeFileSync(snapshot, snapshotContents);
    const ambient = {
      TMUX: "/unowned/socket,1,0",
      TMUX_PANE: "%999",
      ZAPS_TMUX_SOCKET: "unowned",
      ZAPS_MANAGED_TMUX: "1",
      ZAPS_ENVIRONMENT_SNAPSHOT: snapshot,
    };
    const worker = writeServiceScript(
      fixture,
      "worker.mjs",
      `import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));
      let ready = false;
      setInterval(() => {
        if (!ready && fs.existsSync(${JSON.stringify(release)})) {
          ready = true;
          console.log("ARTIFACT_STDOUT_SNAPSHOT");
          console.error("ARTIFACT_STDERR_SNAPSHOT");
          process.stdout.write("ARTIFACT_READY_PARTIAL");
          process.stderr.write("ARTIFACT_STDERR_PARTIAL");
        }
        if (ready && fs.existsSync(${JSON.stringify(emit)})) {
          console.log("\\nLATER_CLIENT_OUTPUT");
        }
      }, 25);`,
    );
    const sibling = writeServiceScript(
      fixture,
      "sibling.mjs",
      `import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(siblingPidFile)}, String(process.pid));
      console.log("SIBLING_READY"); setInterval(() => {}, 1000);`,
    );
    fs.writeFileSync(
      fixture.configPath,
      `export function config(lib) {
      return lib.define({ name: "artifact-lifecycle", services: {
        worker: { start: ${JSON.stringify(worker)}, ready: { output: /ARTIFACT_READY_PARTIAL/ } },
        sibling: { start: ${JSON.stringify(sibling)}, ready: { output: /SIBLING_READY/ } }
      } });
    }`,
    );
    try {
      const version = await fixture.run(["--version"], ambient);
      expect(version.code, version.stderr).toBe(0);
      const start = fixture.spawn(["-b"], ambient);
      await waitForCondition(() => fs.existsSync(workerPidFile) && fs.existsSync(siblingPidFile));
      const daemonPid = pidSchema.parse(fs.readFileSync(daemonPidFile, "utf8"));
      const daemonStatus = await fixture.request("daemon.status", daemonStatusSchema);
      expect(daemonStatus.pid).toBe(daemonPid);
      const daemon = await fixture.ownProcessGroup(daemonPid);
      const workerPid = pidSchema.parse(fs.readFileSync(workerPidFile, "utf8"));
      const initialWorker = await fixture.ownProcessGroup(workerPid);
      const siblingPid = pidSchema.parse(fs.readFileSync(siblingPidFile, "utf8"));
      const initialSibling = await fixture.ownProcessGroup(siblingPid);
      expect(start.child.exitCode, start.stdout + start.stderr).toBeNull();
      fs.writeFileSync(release, "");
      const result = await start.result;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("started (shell)");
      const sessions = await fixture.request("session.list", listSchema);
      expect(sessions).toMatchObject([
        { id, backend: "shell", configPath: fixture.configPath, projectDir: fixture.projectDir },
      ]);
      expect(sessions).toHaveLength(1);
      const initialStatus = await fixture.request("services.list", statusSchema, undefined, id);
      expect(initialStatus).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "worker", state: "ready" }),
          expect.objectContaining({ name: "sibling", state: "ready" }),
        ]),
      );
      const logs = await fixture.run(["logs", "worker"], ambient);
      expect(logs.code, logs.stderr).toBe(0);
      expect(logs.stdout).toContain("ARTIFACT_STDOUT_SNAPSHOT");
      expect(logs.stdout).toContain("ARTIFACT_STDERR_SNAPSHOT");

      const follow = fixture.spawn(["logs", "worker", "--follow"], ambient);
      await waitForCondition(() => follow.stdout.includes("ARTIFACT_STDOUT_SNAPSHOT"));
      fs.writeFileSync(emit, "");
      await waitForCondition(() => follow.stdout.includes("LATER_CLIENT_OUTPUT"));
      fs.unlinkSync(emit);
      follow.child.kill("SIGINT");
      const disconnected = await follow.result;
      expect(disconnected.code, disconnected.stderr).toBe(0);
      const laterLogs = await fixture.run(["logs", "worker"], ambient);
      expect(laterLogs.code, laterLogs.stderr).toBe(0);
      expect(laterLogs.stdout).toContain("LATER_CLIENT_OUTPUT");
      expect(laterLogs.stdout.match(/ARTIFACT_READY_PARTIAL/g)).toHaveLength(1);

      for (const argv of [[], ["-s", id, "attach"]]) {
        const ui = fixture.spawn(argv, ambient, { stdin: true, stdout: true });
        await waitForCondition(() => ui.stdout.includes("artifact-lifecycle"));
        ui.child.stdin.write("q");
        const detached = await ui.result;
        expect(detached.code, detached.stdout + detached.stderr).toBe(0);
        expect(detached.stdout).toContain("\u001b[?1049l");
      }
      for (const argv of [["-b"], ["--backend=shell", "--background"]]) {
        const reused = await fixture.run(argv, ambient);
        expect(reused.code, reused.stderr).toBe(0);
        expect(reused.stdout).toContain("already running (shell)");
      }
      expect(await fixture.request("session.list", listSchema)).toEqual(sessions);
      expect(await fixture.request("services.list", statusSchema, undefined, id)).toEqual(
        initialStatus,
      );
      const retained = await inspection.readProcessIdentity(workerPid);
      expect(retained && sameProcess(initialWorker, retained)).toBe(true);

      const restarted = await fixture.run(["restart", "worker"], ambient);
      expect(restarted.code, restarted.stderr).toBe(0);
      const replacementPid = pidSchema.parse(fs.readFileSync(workerPidFile, "utf8"));
      const replacement = await fixture.ownProcessGroup(replacementPid);
      expect(sameProcess(initialWorker, replacement)).toBe(false);
      await waitForCondition(
        async () => (await inspection.readProcessIdentity(workerPid)) === null,
      );
      const siblingAfter = await inspection.readProcessIdentity(siblingPid);
      expect(siblingAfter && sameProcess(initialSibling, siblingAfter)).toBe(true);
      const daemonAfter = await inspection.readProcessIdentity(daemonPid);
      expect(daemonAfter && sameProcess(daemon, daemonAfter)).toBe(true);
      expect(await fixture.request("session.list", listSchema)).toEqual(sessions);
      const finalStatus = await fixture.request("services.list", statusSchema, undefined, id);
      expect(finalStatus.find(({ name }) => name === "sibling")).toEqual(
        initialStatus.find(({ name }) => name === "sibling"),
      );
      expect(finalStatus.find(({ name }) => name === "worker")?.state).toBe("ready");
      const finalLogs = await fixture.run(["logs", "worker"], ambient);
      expect(finalLogs.code, finalLogs.stderr).toBe(0);
      expect(finalLogs.stdout.match(/ARTIFACT_STDERR_PARTIAL/g)).toHaveLength(1);
      const down = await fixture.run(["down"], ambient);
      expect(down.code, down.stderr).toBe(0);
      expect(await fixture.request("session.list", listSchema)).toEqual([]);
      await waitForCondition(
        async () =>
          (await inspection.readProcessIdentity(replacementPid)) === null &&
          (await inspection.readProcessIdentity(siblingPid)) === null,
      );
      expect(fs.readFileSync(snapshot, "utf8")).toBe(snapshotContents);
    } finally {
      try {
        if (fs.existsSync(daemonPidFile)) {
          const stopped = await fixture.run(["daemon", "stop"], ambient);
          expect(stopped.code, stopped.stderr).toBe(0);
          await waitForCondition(
            () => !fs.existsSync(fixture.socketPath) && !fs.existsSync(daemonPidFile),
          );
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
  }, 60_000);
});
