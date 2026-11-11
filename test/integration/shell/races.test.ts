import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type { ExecutionEvent } from "#src/lib/backend/types.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { runWithEnvironment } from "#src/lib/request-context.js";

import { waitForCondition } from "./helpers.js";
import { shellQuote, withShellStore, writeServiceScript } from "./store-fixture.js";

const inspection = createProcessInspection();
const pidSchema = z.coerce.number().int().positive();

async function birth(file: string) {
  await waitForCondition(() => fs.existsSync(file));
  const pid = pidSchema.parse(fs.readFileSync(file, "utf8"));
  const identity = await inspection.readProcessIdentity(pid);
  if (!identity) {
    throw new Error(`Fixture process vanished: ${pid}`);
  }
  return identity;
}

async function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("shell lifecycle races", () => {
  it("shares compatible pending IPC creates and rejects backend conflict before host effects", async () => {
    await withShellStore(async (fixture, store) => {
      const entered = path.join(fixture.projectDir, "entered");
      const release = path.join(fixture.projectDir, "release");
      const workerPid = path.join(fixture.projectDir, "worker.pid");
      const command = writeServiceScript(
        fixture,
        "worker.mjs",
        `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(workerPid)}, process.pid + '\\n'); console.log('READY'); setInterval(() => {}, 1000);`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `import fs from 'node:fs'; export async function config(lib) {
        fs.appendFileSync(${JSON.stringify(entered)}, 'evaluated\\n');
        while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
        return lib.define({ services: { worker: { start: ${JSON.stringify(command)}, ready: { output: /READY/ } } } }); }`,
      );
      await store.start(fixture.socketPath);
      const params = {
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
      };
      const request = async (data: unknown) =>
        runWithEnvironment(fixture.env, async () =>
          ipcRequest(fixture.socketPath, "session.create", data, 15_000),
        );
      const first = request(params);
      const second = request(params);
      try {
        await waitForCondition(() => fs.existsSync(entered));
        const conflict = await request({
          ...params,
          backend: "tmux",
          tmuxSession: "foreign",
          originPane: "%999",
        });
        expect(conflict.errorCode).toBe("backend_conflict");
        expect(store.sessionCount).toBe(0);
        fixture.assertNoTmux();
      } finally {
        fs.writeFileSync(release, "go");
      }
      const responses = await Promise.all([first, second]);
      for (const response of responses) {
        expect(response.error).toBeUndefined();
      }
      const ids = responses.map(
        (response) => z.object({ id: z.string() }).parse(response.result).id,
      );
      expect(ids[0]).toBe(ids[1]);
      expect(store.sessionCount).toBe(1);
      const session = store.get(ids[0] ?? "");
      if (!session) {
        throw new Error("Missing created session");
      }
      await session.startPromise;
      expect(fs.readFileSync(entered, "utf8")).toBe("evaluated\n");
      expect(fs.readFileSync(workerPid, "utf8").trim().split("\n")).toHaveLength(1);
      await store.destroy(session.id);
      expect(store.hasOwnedWork).toBe(false);
    });
  });

  it("keeps a disconnected accepted task through invalid and accepted reload with captured context", async () => {
    await withShellStore(async (fixture, store) => {
      const configPath = path.join(fixture.projectDir, ".zaps.mts");
      const workerFile = path.join(fixture.projectDir, "worker.pid");
      const taskFile = path.join(fixture.projectDir, "task.pid");
      const release = path.join(fixture.projectDir, "release");
      const worker = writeServiceScript(
        fixture,
        "worker.mjs",
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(workerFile)}, String(process.pid)); console.log('READY'); setInterval(() => {}, 1000);`,
      );
      const task = writeServiceScript(
        fixture,
        "task.mjs",
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(taskFile)}, String(process.pid)); console.log('accepted:' + process.env.RACE_TOKEN); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { console.log('later:' + process.env.RACE_TOKEN); clearInterval(timer); } }, 10);`,
      );
      const service = `{ start: ${JSON.stringify(worker)}, ready: { output: /READY/ } }`;
      fs.writeFileSync(
        configPath,
        `export function config(lib) { return lib.define({ services: { worker: ${service} }, tasks: { held: { name: 'held', run: async (ctx) => { await ctx.exec(${JSON.stringify(task)}); ctx.stdout.write('callback:' + process.env.RACE_TOKEN + '\\n'); } } } }); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env, RACE_TOKEN: "original" },
      });
      await session.startPromise;
      const original = await birth(workerFile);
      await store.start(fixture.socketPath);
      const socket = await connect(fixture.socketPath);
      try {
        socket.write(
          `${JSON.stringify({ id: "accepted", method: "tasks.run", session: session.id, context: { cwd: fixture.projectDir, env: { ...fixture.env, RACE_TOKEN: "captured" } }, params: { key: "held" } })}\n`,
        );
        const accepted = await birth(taskFile);
        const runId = session.taskHistory[0]?.runId;
        if (!runId) {
          throw new Error("Accepted task missing run identity");
        }
        socket.destroy();
        const { config, manager, env, logBuffers, taskExecution } = session;
        fs.writeFileSync(
          configPath,
          "export function config() { throw new Error('invalid candidate'); }",
        );
        await expect(session.reload({ ...fixture.env, RACE_TOKEN: "invalid" })).rejects.toThrow(
          "invalid candidate",
        );
        expect(session.config).toBe(config);
        expect(session.manager).toBe(manager);
        expect(session.env).toBe(env);
        expect(session.logBuffers).toBe(logBuffers);
        expect(await inspection.readProcessIdentity(original.pid)).toEqual(original);
        expect(await inspection.readProcessIdentity(accepted.pid)).toEqual(accepted);
        fs.writeFileSync(
          configPath,
          `export function config(lib) { return lib.define({ name: 'replacement', services: { worker: ${service} } }); }`,
        );
        await session.reload({ ...fixture.env, RACE_TOKEN: "replacement" });
        await session.startPromise;
        expect(session.taskExecution).toBe(taskExecution);
        expect(await inspection.readProcessIdentity(accepted.pid)).toEqual(accepted);
        expect(await inspection.readProcessIdentity(original.pid)).toBeNull();
        fs.writeFileSync(release, "go");
        await waitForCondition(
          () => session.taskHistory.find((run) => run.runId === runId)?.result === "success",
        );
        expect(session.taskOutput.get(runId)?.lines).toEqual(
          expect.arrayContaining(["accepted:captured", "later:captured", "callback:captured"]),
        );
        expect(session.taskHistory.filter((run) => run.runId === runId)).toHaveLength(1);
        await waitForCondition(async () => !(await inspection.readProcessIdentity(accepted.pid)));
      } finally {
        socket.destroy();
        fs.writeFileSync(release, "go");
      }
    });
  });

  it("rejects delayed managed ctx.exec after destroy and cleans an accepted child", async () => {
    await withShellStore(async (fixture, store) => {
      const childFile = path.join(fixture.projectDir, "child.pid");
      const late = path.join(fixture.projectDir, "late");
      const released = path.join(fixture.projectDir, "released");
      const report = path.join(fixture.projectDir, "report");
      const child = writeServiceScript(
        fixture,
        "child.mjs",
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `import fs from 'node:fs'; export function config(lib) { return lib.define({ services: { idle: { start: 'true', flags: { start: false } } }, tasks: { held: { name: 'held', run: async (ctx) => {
        try { await ctx.exec(${JSON.stringify(child)}); } catch {}
        while (!fs.existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
        try { await ctx.exec(${JSON.stringify(`touch ${shellQuote(late)}`)}); fs.writeFileSync(${JSON.stringify(report)}, 'allowed'); }
        catch (error) { fs.writeFileSync(${JSON.stringify(report)}, String(error)); }
      } } } }); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      const running = session.taskExecution.run("held", {
        config: session.config,
        cwd: session.projectDir,
        env: session.env,
        mode: "background",
      });
      const identity = await birth(childFile);
      try {
        await store.destroy(session.id);
        expect(await inspection.readProcessIdentity(identity.pid)).toBeNull();
        fs.writeFileSync(released, "go");
        await waitForCondition(() => fs.existsSync(report));
        expect(fs.readFileSync(report, "utf8")).toContain("session_closing");
        expect(fs.existsSync(late)).toBe(false);
        const result = await running;
        expect(result.success).toBe(false);
        expect(store.hasOwnedWork).toBe(false);
      } finally {
        fs.writeFileSync(released, "go");
        await running;
      }
    });
  });

  it("fails live-port readiness, cleans ownership, then starts exactly one replacement", async () => {
    await withShellStore(async (fixture, store) => {
      const owner = path.join(fixture.projectDir, "owner.json");
      const allow = path.join(fixture.projectDir, "allow");
      const launches = path.join(fixture.projectDir, "launches");
      const command = writeServiceScript(
        fixture,
        "port.mjs",
        `import fs from 'node:fs'; import net from 'node:net'; const server = net.createServer().listen(0, '127.0.0.1', () => { fs.appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n'); fs.writeFileSync(${JSON.stringify(owner)}, JSON.stringify({ pid: process.pid, port: server.address().port })); });`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `import fs from 'node:fs'; export function config(lib) { return lib.define({ services: { worker: { start: ${JSON.stringify(command)}, ready: () => { if (!fs.existsSync(${JSON.stringify(owner)})) return false; if (!fs.existsSync(${JSON.stringify(allow)})) throw new Error('port readiness rejected'); return true; } } } }); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      const first = z
        .object({ pid: z.number(), port: z.number() })
        .parse(JSON.parse(fs.readFileSync(owner, "utf8")));
      expect(session.manager.getStatus("worker").state).toBe("error");
      expect(await inspection.readProcessIdentity(first.pid)).toBeNull();
      const probe = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(first.port, "127.0.0.1", resolve);
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await session.manager.stopService("worker");
      fs.rmSync(owner);
      fs.writeFileSync(allow, "yes");
      await session.manager.restartService("worker");
      expect(session.manager.getStatus("worker").state).toBe("ready");
      expect(fs.readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(2);
      const second = z
        .object({ pid: z.number(), port: z.number() })
        .parse(JSON.parse(fs.readFileSync(owner, "utf8")));
      expect(second.pid).not.toBe(first.pid);
      expect(await inspection.readProcessIdentity(second.pid)).not.toBeNull();
      await store.destroy(session.id);
      expect(await inspection.readProcessIdentity(second.pid)).toBeNull();
    });
  });

  it.each(["leader-exit", "stop"])(
    "bounds real pipe-holder cleanup after %s",
    async (mode) => {
      await withShellStore(async (fixture) => {
        const ready = path.join(fixture.projectDir, "ready");
        const release = path.join(fixture.projectDir, "release");
        const holder = path.join(fixture.projectDir, "holder.mjs");
        fs.writeFileSync(
          holder,
          `import fs from 'node:fs'; process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.stdout.write('holder-tail'); setInterval(() => {}, 1000);`,
        );
        const command =
          mode === "stop"
            ? `${shellQuote(process.execPath)} ${shellQuote(holder)}`
            : writeServiceScript(
                fixture,
                "leader.mjs",
                `import fs from 'node:fs'; import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: 'inherit' }); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { process.stdout.write('leader-tail'); process.exit(23); } }, 10);`,
              );
        const events: ExecutionEvent[] = [];
        const observedMembers = new Map<number, ProcessIdentity>();
        const runner = new ProcessRunner({
          readProcessIdentity: async (pid) => {
            const current = await inspection.readProcessIdentity(pid);
            if (current) {
              observedMembers.set(pid, current);
            }
            return current;
          },
          onLines: () => {
            /* Events own output. */
          },
          onExit: () => {
            /* Observed through subscribed events. */
          },
        });
        const unsubscribe = runner.subscribe((event) => events.push(event));
        try {
          const handle = runner.spawnOwned({
            unitId: "holder",
            generation: 1,
            command: `exec ${command}`,
            cwd: fixture.projectDir,
            env: { ...fixture.env },
          });
          const identity = await birth(ready);
          await waitForCondition(() => {
            const observed = observedMembers.get(identity.pid);
            return observed !== undefined && sameProcess(observed, identity);
          });
          const started = Date.now();
          if (mode === "leader-exit") {
            fs.writeFileSync(release, "go");
          } else {
            await runner.stop(handle);
          }
          await waitForCondition(() => events.some((event) => event.kind === "exit"), 7500);
          expect(Date.now() - started).toBeLessThan(7500);
          expect(events.filter((event) => event.kind === "leaderExit")).toHaveLength(1);
          expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
          expect(events.at(-1)).toMatchObject({
            kind: "exit",
            ...(mode === "leader-exit" ? { code: 23 } : { signal: "SIGKILL" }),
          });
          expect(events.at(-1)).not.toHaveProperty("cleanupError");
          expect(
            events
              .flatMap((event) => (event.kind === "output" ? event.lines : []))
              .some((line) => line.includes("holder-tail")),
          ).toBe(true);
          await waitForCondition(async () => {
            const actual = await inspection.readProcessIdentity(identity.pid);
            return !actual || !sameProcess(actual, identity);
          });
        } finally {
          unsubscribe();
          await runner.dispose();
        }
      });
    },
    15_000,
  );

  it("retains ownership diagnostics instead of signalling an unverified real group", async () => {
    await withShellStore(async (fixture) => {
      const ready = path.join(fixture.projectDir, "ready");
      const command = writeServiceScript(
        fixture,
        "unknown.mjs",
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      let unknown = false;
      const signals: number[] = [];
      const journal = new Set<number>();
      const runner = new ProcessRunner({
        onLines: () => {
          /* Events own output. */
        },
        onExit: () => {
          /* Observed through subscribed events. */
        },
        record: (pid) => {
          journal.add(pid);
        },
        unrecord: (pid) => {
          journal.delete(pid);
        },
        readProcessIdentity: async (pid) => {
          const actual = await inspection.readProcessIdentity(pid);
          return actual && unknown ? { ...actual, startTime: "unverified" } : actual;
        },
        kill: (pid, signal) => {
          signals.push(pid);
          process.kill(pid, signal);
        },
      });
      try {
        const handle = runner.spawnOwned({
          unitId: "unknown",
          generation: 1,
          command: `exec ${command}`,
          cwd: fixture.projectDir,
          env: { ...fixture.env },
        });
        const identity = await birth(ready);
        unknown = true;
        const started = Date.now();
        await expect(runner.stop(handle)).rejects.toThrow("Unverified");
        expect(Date.now() - started).toBeLessThan(7500);
        expect(signals).toEqual([]);
        expect(journal.has(identity.pid)).toBe(true);
        expect(runner.getPid(handle)).toBe(identity.pid);
        expect(await inspection.readProcessIdentity(identity.pid)).toEqual(identity);
        expect(() =>
          runner.spawnOwned({
            unitId: "unknown",
            generation: 2,
            command: "true",
            cwd: fixture.projectDir,
            env: {},
          }),
        ).toThrow("still owned");
        unknown = false;
        await runner.stop(handle);
        expect(journal.size).toBe(0);
      } finally {
        unknown = false;
        await runner.dispose();
      }
    });
  });
});
