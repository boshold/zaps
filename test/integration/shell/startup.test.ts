import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionId } from "#src/daemon/session.js";
import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import { sessionListEntrySchema } from "#src/lib/backend/schemas.js";
import { daemonStatusSchema, projectedStatusSchema } from "#src/lib/backend/wire.js";

import { createShellTestEnvironment, waitForCondition } from "./helpers.js";
import { writeServiceScript } from "./store-fixture.js";

type Fixture = ReturnType<typeof createShellTestEnvironment>;

const binary = process.env.ZAPS_SHELL_TEST_BINARY;
const command = binary
  ? { file: path.resolve(binary), args: [] }
  : { file: process.execPath, args: [path.resolve("dist/cli.mjs")] };

const inspection = createProcessInspection();
const listSchema = z.array(sessionListEntrySchema);
const statusSchema = z.array(projectedStatusSchema);
const logsSchema = z.array(z.string());
const bothTty = { stdin: true, stdout: true };

function daemonPidFile(fixture: Fixture): string {
  return path.join(fixture.runtimeDir, "zaps", "daemon.pid");
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = createShellTestEnvironment({ command, configName: ".zaps.mts" });
  try {
    await run(fixture);
    fixture.assertNoTmux();
  } finally {
    try {
      const pidFile = daemonPidFile(fixture);
      if (fs.existsSync(pidFile)) {
        const pid = z.coerce.number().int().positive().parse(fs.readFileSync(pidFile, "utf8"));
        const daemon = await fixture.request("daemon.status", daemonStatusSchema);
        expect(daemon.pid).toBe(pid);
        const stop = await fixture.run(["daemon", "stop"]);
        expect(stop.code, stop.stderr).toBe(0);
        await waitForCondition(() => !fs.existsSync(fixture.socketPath) && !fs.existsSync(pidFile));
      }
    } finally {
      await fixture.cleanup();
    }
  }
}

function expectPlainError(output: string, message: string): void {
  expect(output).toContain(message);
  expect(output).not.toContain("");
}

async function useUi(
  fixture: Fixture,
  argv: string[],
  name: string,
  env: Record<string, string> = {},
): Promise<void> {
  const ui = fixture.spawn(argv, env, bothTty);
  await waitForCondition(() => ui.stdout.includes(name) || ui.child.exitCode !== null);
  expect(ui.stdout).toContain("[?1049h");
  expect(ui.stdout).toContain(name);
  ui.child.stdin.write("q");
  await waitForCondition(() => ui.child.exitCode !== null || ui.child.signalCode !== null);
  const result = await ui.result;
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("[?1049l");
}

describe("public shell startup", () => {
  it("waits for readiness, then bare and explicit attach reuse the same process and retained logs", async () => {
    await withFixture(async (fixture) => {
      const entered = path.join(fixture.projectDir, "worker-entered");
      const release = path.join(fixture.projectDir, "release-worker");
      const starts = path.join(fixture.projectDir, "startup-hooks");
      const worker = writeServiceScript(
        fixture,
        "worker.mjs",
        `import fs from "node:fs";
          fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
          let printed = false;
          setInterval(() => {
            if (!printed && fs.existsSync(${JSON.stringify(release)})) {
              printed = true;
              console.log("PUBLIC_WORKER_READY");
            }
          }, 25);`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `import fs from "node:fs";
        export function config(lib) { return lib.define({
          name: "public-shell", services: {
            worker: { start: ${JSON.stringify(worker)}, ready: { output: /PUBLIC_WORKER_READY/ } }
          },
          hooks: { onBeforeStart: () => { fs.appendFileSync(${JSON.stringify(starts)}, ${JSON.stringify("start\n")}); } }
        }); }`,
      );
      const snapshot = path.join(fixture.rootDir, "inherited.json");
      const snapshotContents = JSON.stringify({ PATH: "/invalid", XDG_RUNTIME_DIR: "/invalid" });
      fs.writeFileSync(snapshot, snapshotContents);
      const env = {
        TMUX: "/unowned/socket,1,0",
        TMUX_PANE: "%999",
        ZAPS_TMUX_SOCKET: "zaps",
        ZAPS_MANAGED_TMUX: "1",
        ZAPS_ENVIRONMENT_SNAPSHOT: snapshot,
      };

      const start = fixture.spawn(["-b"], env);
      await waitForCondition(() => fs.existsSync(entered) || start.child.exitCode !== null);
      expect(start.child.exitCode, start.stdout + start.stderr).toBeNull();
      const pid = z.coerce.number().int().positive().parse(fs.readFileSync(entered, "utf8"));
      const identity = await inspection.readProcessIdentity(pid);
      if (!identity) {
        throw new Error("Expected live shell worker");
      }
      fs.writeFileSync(release, "");
      const background = await start.result;
      expect(background.code, background.stderr).toBe(0);
      expect(background.stdout).toContain("started (shell)");
      expect(background.stdout).toContain("zaps attach");
      expect(background.stdout).not.toContain("");
      const id = sessionId(fixture.configPath, fixture.projectDir);
      const before = await fixture.request("session.list", listSchema);
      expect(before).toMatchObject([{ id, backend: "shell" }]);
      const initialStatus = await fixture.request("services.list", statusSchema, undefined, id);
      expect(initialStatus).toMatchObject([{ name: "worker", state: "ready" }]);
      const logs = await fixture.request("logs.snapshot", logsSchema, { service: "worker" }, id);
      expect(logs).toContain("PUBLIC_WORKER_READY");

      await useUi(fixture, [], "public-shell", env);
      await useUi(fixture, ["-s", id, "attach"], "public-shell", env);
      expect(await fixture.request("session.list", listSchema)).toEqual(before);
      const reopened = await fixture.request("services.list", statusSchema, undefined, id);
      expect(reopened[0]?.startedAt).toBe(initialStatus[0]?.startedAt);
      const stillRunning = await inspection.readProcessIdentity(pid);
      expect(stillRunning && sameProcess(identity, stillRunning)).toBe(true);
      expect(await fixture.request("logs.snapshot", logsSchema, { service: "worker" }, id)).toEqual(
        logs,
      );

      const conflict = await fixture.run(["-B", "tmux", "-b"], env);
      expect(conflict.code).toBe(1);
      expectPlainError(conflict.stderr, "backend_conflict");
      expect(conflict.stderr).toContain("zaps down");
      expect(await fixture.request("session.list", listSchema)).toEqual(before);

      const stopped = await fixture.run(["stop", "worker"]);
      expect(stopped.code).toBe(0);
      const repeated = await fixture.run(["--backend=shell", "up", "-b", "-s", id], env);
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain("already running (shell)");
      await useUi(fixture, [], "public-shell", env);
      expect(await fixture.request("services.list", statusSchema, undefined, id)).toMatchObject([
        { name: "worker", state: "stopped" },
      ]);
      expect(fs.readFileSync(starts, "utf8")).toBe("start\n");
      expect(fs.readFileSync(snapshot, "utf8")).toBe(snapshotContents);
    });
  }, 60_000);

  it("opens a new explicit shell UI in the invoking terminal", async () => {
    await withFixture(async (fixture) => {
      await useUi(fixture, ["--backend", "shell"], "shell-fixture");
      expect(await fixture.request("session.list", listSchema)).toMatchObject([
        { backend: "shell" },
      ]);
    });
  });

  it("checks each TTY stream before creating or attaching", async () => {
    await withFixture(async (fixture) => {
      for (const terminal of [
        { stdin: false, stdout: true },
        { stdin: true, stdout: false },
      ]) {
        const run = fixture.spawn(["-B", "shell"], {}, terminal);
        // eslint-disable-next-line no-await-in-loop -- separate preflight for each terminal edge
        const result = await run.result;
        expect(result.code).toBe(1);
        expectPlainError(result.stdout + result.stderr + run.redirectedStdout, "zaps -b");
        expect(fs.existsSync(fixture.socketPath)).toBe(false);
        expect(fs.existsSync(daemonPidFile(fixture))).toBe(false);
      }
      const invalid = fixture.spawn(["up", "--", "-b"], {}, bothTty);
      const invalidResult = await invalid.result;
      expect(invalidResult.code).toBe(1);
      expectPlainError(invalidResult.stdout + invalidResult.stderr, "too many arguments");
      expect(fs.existsSync(fixture.socketPath)).toBe(false);

      const start = await fixture.run(["up", "--detach", "-B", "shell"]);
      expect(start.code, start.stderr).toBe(0);
      const before = await fixture.request("session.list", listSchema);
      const attach = fixture.spawn(["attach"], {}, { stdin: true, stdout: false });
      const failed = await attach.result;
      expect(failed.code).toBe(1);
      expectPlainError(
        failed.stdout + failed.stderr + attach.redirectedStdout,
        "interactive terminal",
      );
      expect(await fixture.request("session.list", listSchema)).toEqual(before);
    });
  });

  it("uses the effective config and project identity instead of the invoking directory", async () => {
    await withFixture(async (fixture) => {
      const other = path.join(fixture.projectDir, "effective");
      fs.mkdirSync(other);
      fs.writeFileSync(
        fixture.configPath,
        `export function config(lib) { return lib.define({
          name: "identity", cwd: () => process.env.EFFECTIVE_DIR,
          services: { worker: { start: "exit 99", flags: { start: false } } }
        }); }`,
      );
      const first = await fixture.run(["--background"], { EFFECTIVE_DIR: fixture.projectDir });
      expect(first.code, first.stderr).toBe(0);
      const second = await fixture.run(["up", "--background"], { EFFECTIVE_DIR: other });
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain("started (shell)");
      const localConfig = path.join(fixture.projectDir, ".local.zaps.mts");
      fs.copyFileSync(fixture.configPath, localConfig);
      const third = await fixture.run(["-b"], { EFFECTIVE_DIR: other });
      expect(third.code, third.stderr).toBe(0);
      expect(third.stdout).toContain("started (shell)");
      const sessions = await fixture.request("session.list", listSchema);
      expect(sessions.map(({ id }) => id)).toEqual([
        sessionId(fixture.configPath, fixture.projectDir),
        sessionId(fixture.configPath, other),
        sessionId(localConfig, other),
      ]);
    });
  });

  it("reports a failed tracked startup hook without replaying it", async () => {
    await withFixture(async (fixture) => {
      const marker = path.join(fixture.projectDir, "startup-hooks");
      fs.writeFileSync(
        fixture.configPath,
        `import fs from "node:fs";
        export function config(lib) { return lib.define({ name: "failed-startup",
          services: { worker: { start: "exit 99", flags: { start: false } } },
          hooks: { onBeforeStart: () => {
            fs.appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify("start\n")});
            throw new Error("Public startup hook failed");
          } }
        }); }`,
      );
      const result = await fixture.run(["-b"]);
      expect(result.code).toBe(1);
      expectPlainError(result.stderr, "Public startup hook failed");
      expect(result.stdout).not.toContain("started (shell)");
      expect(fs.readFileSync(marker, "utf8")).toBe("start\n");
    });
  });

  it("refuses a connectable legacy daemon before creating a shell session", async () => {
    await withFixture(async (fixture) => {
      const methods: string[] = [];
      const request = z.object({ id: z.string(), method: z.string() });
      const server = net.createServer((socket) => {
        const input = createInterface({ input: socket });
        input.once("line", (line) => {
          const { id, method } = request.parse(JSON.parse(line));
          methods.push(method);
          let result: unknown = { pid: process.pid, sessions: [] };
          if (method === "daemon.ping") {
            result = "pong";
          } else if (method === "session.list") {
            result = [];
          }
          socket.end(`${JSON.stringify({ id, result })}\n`);
        });
      });
      const pidFile = daemonPidFile(fixture);
      fs.mkdirSync(path.dirname(pidFile));
      fs.writeFileSync(pidFile, String(process.pid));
      await new Promise<void>((resolve) => server.listen(fixture.socketPath, resolve));
      try {
        const result = await fixture.run(["-b"]);
        expect(result.code).toBe(1);
        expectPlainError(result.stderr, "backend_unavailable");
        expect(result.stderr).toContain("Upgrade Zaps and restart the daemon");
        expect(methods).toEqual(["session.list", "daemon.ping", "daemon.status"]);
        expect(fs.readFileSync(pidFile, "utf8")).toBe(String(process.pid));
        expect(server.listening).toBe(true);
      } finally {
        fs.unlinkSync(pidFile);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
});
