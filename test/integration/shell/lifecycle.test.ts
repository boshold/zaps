import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore, writeServiceScript } from "./store-fixture.js";

describe("shell session startup", () => {
  it("uses shared dependencies, flags.start, cwd/env, ports, URLs and detached preferences", async () => {
    await withShellStore(async (fixture, store) => {
      const cwd = path.join(fixture.projectDir, "working dir");
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(fixture.projectDir, ".env"), "PROJECT_VALUE=project\n");
      const dependency = writeServiceScript(
        fixture,
        "dependency.mjs",
        `
        import fs from 'node:fs';
        fs.writeFileSync(${JSON.stringify(path.join(cwd, "dependency-ready"))}, 'ready');
        console.log('DEPENDENCY_READY'); setInterval(() => {}, 1000);
      `,
      );
      const worker = writeServiceScript(
        fixture,
        "worker.mjs",
        `
        import fs from 'node:fs'; import http from 'node:http';
        if (!fs.existsSync('dependency-ready')) throw new Error('dependency not ready');
        console.log(JSON.stringify({ cwd: process.cwd(), captured: process.env.CAPTURED,
          project: process.env.PROJECT_VALUE, service: process.env.SERVICE_VALUE }));
        http.createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1', function() { console.log('WORKER_READY'); });
      `,
      );
      fs.writeFileSync(
        fixture.configPath,
        `export function config(lib) { return lib.define({ name: 'shell-startup', services: {
        dependency: { start: ${JSON.stringify(dependency)}, ready: { output: /DEPENDENCY_READY/ }, detached: true },
        worker: { start: ${JSON.stringify(worker)}, dependsOn: ['dependency'], cwd: ${JSON.stringify(cwd)},
          env: { SERVICE_VALUE: 'service' }, ready: { output: /WORKER_READY/ }, detached: false },
        disabled: { start: 'exit 99', flags: { start: false } }
      }}); }`,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env, CAPTURED: "invocation" },
      });
      await session.startPromise;
      expect(session.manager.getStatus("dependency")).toMatchObject({
        state: "ready",
        isDetached: true,
      });
      const status = session.manager.getStatus("worker");
      expect(status?.state).toBe("ready");
      expect(status?.isDetached).not.toBe(true);
      expect(status?.ports.length).toBeGreaterThan(0);
      expect(status?.url).toContain(String(status?.ports[0]));
      expect(session.manager.getStatus("disabled")?.state).toBe("stopped");
      expect(session.logBuffers.get("worker")?.snapshot()).toContain(
        JSON.stringify({
          cwd,
          captured: "invocation",
          project: "project",
          service: "service",
        }),
      );
      expect(session.subscribers.size).toBe(0);
    });
  });

  it.each(["rejection", "timeout"])(
    "cleans owned PID and port before readiness %s",
    async (failure) => {
      await withShellStore(async (fixture, store) => {
        const ownerFile = path.join(fixture.projectDir, "owner.json");
        const command = writeServiceScript(
          fixture,
          "failed-ready.mjs",
          `
        import fs from 'node:fs'; import net from 'node:net';
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(ownerFile)},
          JSON.stringify({ pid: process.pid, port: server.address().port })));
      `,
        );
        fs.writeFileSync(
          fixture.configPath,
          `import fs from 'node:fs';
        export function config(lib) { return lib.define({ name: 'shell-failure', services: {
          worker: { start: ${JSON.stringify(command)}, ready: async () => {
            if (${JSON.stringify(failure)} === 'rejection' && fs.existsSync(${JSON.stringify(ownerFile)})) throw new Error('readiness rejected');
            return false;
          } }
        }}); }
      `,
        );
        const session = await store.create({
          backend: "shell",
          configPath: fixture.configPath,
          projectDir: fixture.projectDir,
          shellEnv: { ...fixture.env },
        });
        await session.startPromise;
        expect(session.manager.getStatus("worker")).toMatchObject({
          state: "error",
          lastError: expect.stringContaining(
            failure === "rejection" ? "readiness rejected" : "timed out",
          ),
        });
        const owner = z
          .object({ pid: z.number().int().positive(), port: z.number().int().positive() })
          .parse(JSON.parse(fs.readFileSync(ownerFile, "utf8")));
        const inspection = createProcessInspection();
        await waitForCondition(async () => !(await inspection.readProcessIdentity(owner.pid)));
        expect(await inspection.detectPortsForPid(owner.pid)).toEqual([]);
        const server = net.createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(owner.port, "127.0.0.1", resolve);
          });
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      });
    },
    80_000,
  );
});
