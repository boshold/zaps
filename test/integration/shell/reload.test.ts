import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore, writeServiceScript } from "./store-fixture.js";

describe("shell reload", () => {
  it("preflights all candidates before preserving or replacing live ownership", async () => {
    await withShellStore(async (fixture, store) => {
      const configPath = path.join(fixture.projectDir, ".zaps.mts");
      const pidFile = path.join(fixture.projectDir, "pid");
      const command = writeServiceScript(
        fixture,
        "worker.mjs",
        `import fs from 'node:fs';
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        console.log('READY'); setInterval(() => {}, 1000);`,
      );
      const service = `{ start: ${JSON.stringify(command)}, ready: { output: /READY/ } }`;
      const write = (body: string) =>
        fs.writeFileSync(configPath, `export function config(lib) { return lib.define(${body}); }`);
      write(`{ name: 'original', services: { worker: ${service} } }`);
      const session = await store.create({
        backend: "shell",
        configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      const inspection = createProcessInspection();
      const pid = z.coerce.number().int().positive().parse(fs.readFileSync(pidFile, "utf8"));
      const birth = await inspection.readProcessIdentity(pid);
      expect(birth).not.toBeNull();
      const { config, manager, logBuffers, backend, taskExecution } = session;
      const stop = vi.spyOn(manager, "stopAll");
      const close = vi.spyOn(manager, "closeAdmission");
      const cancel = vi.spyOn(taskExecution, "cancelPresentations");
      for (const candidate of [
        `{ services: { worker: { start: 42 } } }`,
        `{ services: { worker: ${service}, hidden: { start: 'true', raw: true, flags: { start: false }, lazyPane: true } } }`,
        `{ cwd: ${JSON.stringify(fixture.rootDir)}, services: { worker: ${service} } }`,
      ]) {
        write(candidate);
        await expect(session.reload()).rejects.toThrow();
        expect(await inspection.readProcessIdentity(pid)).toEqual(birth);
        expect(session.config).toBe(config);
        expect(session.manager).toBe(manager);
        expect(session.logBuffers).toBe(logBuffers);
        expect(session.backend).toBe(backend);
        expect(taskExecution.accepting).toBe(true);
      }
      expect(stop).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      const broadcast = vi.spyOn(session, "broadcast");
      write(
        `{ name: 'replacement', services: { worker: { ...${service}, lazyPane: true }, disabled: { start: 'exit 99', flags: { start: false } } }, layout: { direction: 'columns', children: [{ pane: '@tui' }, { pane: 'worker' }, { pane: 'disabled' }] } }`,
      );
      await session.reload();
      await session.startPromise;
      expect(await inspection.readProcessIdentity(pid)).toBeNull();
      expect(session.backend).toBe(backend);
      expect(session.taskExecution).toBe(taskExecution);
      expect(session.manager.getStatus("worker")?.state).toBe("ready");
      expect(session.manager.getStatus("disabled")?.state).toBe("stopped");
      expect(session.attachSnapshot()).toMatchObject({ backend: "shell", name: "replacement" });
      expect(
        broadcast.mock.calls.find(([event]) => event.event === "session.configReloaded")?.[0].data,
      ).toMatchObject({ backend: "shell", capabilities: backend.capabilities });
      write(`{ services: { worker: { start: 'exit 17', ready: { output: /NEVER/ } } } }`);
      await session.reload();
      await session.startPromise;
      await waitForCondition(() => session.manager.getStatus("worker")?.state === "error");
      expect(session.manager.getStatus("worker")?.state).toBe("error");
      expect(session.config.project.name).not.toBe("replacement");
      expect(taskExecution.accepting).toBe(true);
    });
  });

  it("isolates candidate startup, newer defaults, accepted tasks and fresh dotenv values", async () => {
    await withShellStore(async (fixture, store) => {
      const configPath = path.join(fixture.projectDir, ".zaps.mts");
      const evaluated = path.join(fixture.projectDir, "evaluated");
      const release = path.join(fixture.projectDir, "release");
      const taskRelease = path.join(fixture.projectDir, "task-release");
      const command = writeServiceScript(
        fixture,
        "env.mjs",
        `console.log('READY:' + process.env.TOKEN + ':' + process.env.DOT); setInterval(() => {}, 1000);`,
      );
      const service = `{ start: ${JSON.stringify(command)}, ready: { output: /READY/ }, flags: { start: false } }`;
      fs.writeFileSync(path.join(fixture.projectDir, ".env"), "DOT=one\n");
      fs.writeFileSync(
        configPath,
        `import fs from 'node:fs'; export function config(lib) { return lib.define({ services: { worker: ${service} }, tasks: { old: { name: 'old', run: async (ctx) => {
        while (!fs.existsSync(${JSON.stringify(taskRelease)})) await new Promise(resolve => setImmediate(resolve));
        await ctx.exec(${JSON.stringify(String.raw`printf "child:%s\n" "$TOKEN"`)}); await lib.service.start('worker'); ctx.stdout.write('old:' + process.env.TOKEN + '\\n');
      } } } }); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env, TOKEN: "old" },
      });
      await session.startPromise;
      const owner = session.taskExecution;
      const old = owner.run("old", {
        config: session.config,
        cwd: session.projectDir,
        env: session.env,
        mode: "background",
      });
      fs.writeFileSync(
        configPath,
        `import fs from 'node:fs'; export async function config(lib) {
        fs.writeFileSync(${JSON.stringify(evaluated)}, process.env.TOKEN);
        while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setImmediate(resolve));
        return lib.define({ name: process.env.TOKEN, services: { worker: { ...${service}, flags: { start: true } } }, tasks: { fresh: { name: 'fresh', run: (ctx) => ctx.stdout.write('fresh:' + process.env.TOKEN + '\\n') } } }); }`,
      );
      const reload = session.reload({ ...fixture.env, TOKEN: "A" });
      await waitForCondition(() => fs.existsSync(evaluated));
      session.updateContext({ ...fixture.env, TOKEN: "B" });
      fs.writeFileSync(release, "go");
      await reload;
      await session.startPromise;
      expect(fs.readFileSync(evaluated, "utf8")).toBe("A");
      expect(session.config.project.name).toBe("A");
      expect(session.logBuffers.get("worker")?.snapshot()).toContain("READY:A:one");
      expect(session.env.TOKEN).toBe("B");
      fs.writeFileSync(taskRelease, "go");
      const result = await old;
      expect(result.success).toBe(true);
      expect(owner).toBe(session.taskExecution);
      expect(session.taskOutput.get(result.runId)?.lines).toEqual(
        expect.arrayContaining(["old:old", "child:old"]),
      );
      const fresh = await owner.run("fresh", {
        config: session.config,
        cwd: session.projectDir,
        env: session.env,
        mode: "background",
      });
      expect(session.taskOutput.get(fresh.runId)?.lines).toContain("fresh:B");
      fs.writeFileSync(path.join(fixture.projectDir, ".env"), "DOT=two\n");
      await session.reload();
      await session.startPromise;
      expect(session.env.DOT).toBe("two");
      expect(session.shellEnv.DOT).toBeUndefined();
      expect(session.logBuffers.get("worker")?.snapshot()).toContain("READY:B:two");
    });
  });
});
