import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createShutdownAll } from "#src/daemon/index.js";
import { registerShutdownHook } from "#src/daemon/shutdown.js";
import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore, writeServiceScript } from "./store-fixture.js";

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe("shell cleanup", () => {
  it("destroys unsubscribed services and task groups, preserving reverse order and private onStop authority", async () => {
    await withShellStore(async (fixture, store) => {
      const order = path.join(fixture.projectDir, "order");
      const workerFile = path.join(fixture.projectDir, "worker");
      const taskFile = path.join(fixture.projectDir, "task");
      const worker = writeServiceScript(
        fixture,
        "worker.mjs",
        `
        import fs from 'node:fs'; import net from 'node:net';
        const server = net.createServer().listen(0, '127.0.0.1', () => {
          fs.writeFileSync(${JSON.stringify(workerFile)}, JSON.stringify({pid:process.pid,port:server.address().port}));
          console.log('READY');
        });`,
      );
      const task = writeServiceScript(
        fixture,
        "task.mjs",
        `
        import fs from 'node:fs';
        fs.writeFileSync(${JSON.stringify(taskFile)}, String(process.pid));
        setInterval(() => {}, 1000);`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `export function config(lib) { return lib.define({
        services: {
          dependency: { start: ${JSON.stringify(worker)}, ready: { output: /READY/ }, onStop: () => lib.task.run('dependencyStopped') },
          dependent: { start: ${JSON.stringify(worker)}, dependsOn: ['dependency'], ready: { output: /READY/ }, onStop: () => lib.task.run('dependentStopped') }
        }, tasks: {
          background: { name: 'background', commands: ${JSON.stringify(task)} },
          dependencyStopped: { name: 'dependency stopped', commands: ${JSON.stringify(`printf dependency >> '${order}'`)} },
          dependentStopped: { name: 'dependent stopped', commands: ${JSON.stringify(`printf dependent >> '${order}'`)} }
        }
      }); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      expect(session.subscribers.size).toBe(0);
      expect(store.sessionCount).toBe(1);
      expect(store.hasOwnedWork).toBe(true);
      const workerInfo = z
        .object({ pid: z.number().int().positive(), port: z.number().int().positive() })
        .parse(JSON.parse(fs.readFileSync(workerFile, "utf8")));
      const ports = session.manager.getAllStatuses().flatMap((status) => status.ports);
      expect(ports.length).toBeGreaterThanOrEqual(2);
      const running = session.taskExecution.run("background", {
        config: session.config,
        cwd: session.projectDir,
        env: session.env,
        mode: "background",
      });
      await waitForCondition(() => fs.existsSync(taskFile));
      const taskPid = z.coerce.number().int().positive().parse(fs.readFileSync(taskFile, "utf8"));
      const inspection = createProcessInspection();
      expect(await inspection.readProcessIdentity(taskPid)).not.toBeNull();
      await store.destroy(session.id);
      const taskResult = await running;
      expect(taskResult.success).toBe(false);
      await store.destroy(session.id);
      expect(store.hasOwnedWork).toBe(false);
      expect(await inspection.readProcessIdentity(taskPid)).toBeNull();
      expect(await inspection.readProcessIdentity(workerInfo.pid)).toBeNull();
      for (const port of ports) {
        expect(await portOpen(port)).toBe(false);
      }
      expect(fs.readFileSync(order, "utf8")).toBe("dependentdependency");
      await expect(
        session.taskExecution.run("background", {
          config: session.config,
          cwd: session.projectDir,
          env: session.env,
          mode: "background",
        }),
      ).rejects.toThrow("session_closing");
    });
  });

  it("cancels partial startup and drains a real shutdown ACK over the socket", async () => {
    await withShellStore(async (fixture, store) => {
      const pidFile = path.join(fixture.projectDir, "partial-pid");
      const command = writeServiceScript(
        fixture,
        "partial.mjs",
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(() => {},1000);`,
      );
      fs.writeFileSync(
        fixture.configPath,
        `export function config(lib) { return lib.define({services:{ partial:{start:${JSON.stringify(command)},ready:{output:/NEVER/}}}}); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await waitForCondition(() => fs.existsSync(pidFile));
      const pid = z.coerce.number().int().positive().parse(fs.readFileSync(pidFile, "utf8"));
      const socketPath = path.join(fixture.rootDir, "shutdown.sock");
      await store.start(socketPath);
      const shutdown = createShutdownAll(store, vi.fn(), vi.fn());
      registerShutdownHook(shutdown);
      try {
        const response = await ipcRequest(socketPath, "daemon.shutdown");
        expect(response).toMatchObject({ result: { shuttingDown: true } });
        await store.flushShutdownResponses();
        await session.startPromise;
        expect(store.sessionCount).toBe(0);
        expect(await createProcessInspection().readProcessIdentity(pid)).toBeNull();
        await shutdown();
      } finally {
        registerShutdownHook(null);
      }
    });
  });
  it("flushes a shutdown error instead of ACKing incomplete owner cleanup", async () => {
    await withShellStore(async (fixture, store) => {
      fs.writeFileSync(
        fixture.configPath,
        `export function config(lib) { return lib.define({services:{idle:{start:'true',flags:{start:false}}}}); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      const destroy = vi
        .spyOn(store, "destroy")
        .mockRejectedValueOnce(new Error("owned child cleanup failed"));
      const socketPath = path.join(fixture.rootDir, "failed-shutdown.sock");
      await store.start(socketPath);
      const shutdown = createShutdownAll(store, vi.fn(), vi.fn());
      registerShutdownHook(shutdown);
      try {
        const response = await ipcRequest(socketPath, "daemon.shutdown");
        expect(response.error).toContain("Daemon cleanup incomplete");
        expect(response.result).toBeUndefined();
        await store.flushShutdownResponses();
        expect(store.hasOwnedWork).toBe(true);
        expect(destroy).toHaveBeenCalledWith(session.id);
      } finally {
        registerShutdownHook(null);
      }
    });
  });
});
