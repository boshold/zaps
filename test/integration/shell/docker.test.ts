import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ExecutionHandle } from "#src/lib/backend/types.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore } from "./store-fixture.js";

const execFileAsync = promisify(execFile);

// Docker is a Linux-only acceptance prerequisite; core shell tests run on both hosts.
describe.skipIf(process.platform !== "linux")("shell Docker execution units", () => {
  it("keeps one producer through owner/member controls and rejects rebuild before effects", async () => {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
    await withShellStore(async (fixture, store) => {
      const project = path.basename(fixture.rootDir).toLowerCase();
      const composeFile = path.join(fixture.projectDir, "compose.yml");
      fs.writeFileSync(
        composeFile,
        `name: ${project}\nservices:\n  owner:\n    image: alpine:3.21\n    command: [sh, -c, 'echo OWNER_READY; exec tail -f /dev/null']\n  member:\n    image: alpine:3.21\n    command: [sh, -c, 'echo MEMBER_READY; exec tail -f /dev/null']\n  observer:\n    image: alpine:3.21\n    command: [sh, -c, 'echo OBSERVER_READY; exec tail -f /dev/null']\n`,
      );
      const compose = async (...args: string[]) =>
        execFileAsync("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
          cwd: fixture.projectDir,
          timeout: 30_000,
        });
      const ids = async () => {
        const { stdout } = await compose("ps", "--all", "--format", "json");
        return stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => z.object({ ID: z.string(), Service: z.string() }).parse(JSON.parse(line)))
          .toSorted((left, right) => left.Service.localeCompare(right.Service));
      };
      try {
        fs.writeFileSync(
          fixture.configPath,
          `export function config(lib) { return lib.define({ services: {
          cache: { docker: { file: ${JSON.stringify(composeFile)}, service: ['owner', 'member', 'observer'], expand: true,
            build: true, forceRecreate: true, renewVolumes: true } }
        }}); }`,
        );
        await store.start(fixture.socketPath);
        const session = await store.create({
          backend: "shell",
          configPath: fixture.configPath,
          projectDir: fixture.projectDir,
          shellEnv: { ...fixture.env },
        });
        await session.startPromise;
        for (const name of ["owner", "member"]) {
          expect(session.manager.getStatus(name).state).toBe("ready");
        }
        const { runtime } = session.backend;
        const start = vi.spyOn(runtime, "start");
        const stop = vi.spyOn(runtime, "stop");
        const initialIds = await ids();
        expect(initialIds).toHaveLength(3);
        const buffer = session.logBuffers.get("owner");
        expect(buffer).toBeDefined();
        expect(session.logBuffers.get("member")).toBe(buffer);
        const producerPid = session.manager.getStatus("owner").pid;
        const events: string[] = [];
        const unsubscribe = runtime.subscribe((event) => {
          if (event.kind === "output") {
            events.push(...event.lines);
          }
        });
        const marker = async (service: string, label: string) => {
          const value = `UNIT_${label}_${Date.now()}`;
          await compose("exec", "-T", service, "sh", "-c", `echo ${value} > /proc/1/fd/1`);
          await waitForCondition(
            () => buffer?.snapshot().some((line) => line.includes(value)) === true,
            10_000,
          );
          expect(events.filter((line) => line.includes(value))).toHaveLength(1);
        };
        try {
          await session.manager.restartService("owner");
          expect(session.manager.getStatus("owner").state).toBe("ready");
          await marker("observer", "OWNER_RESTART");
          await session.manager.stopService("owner");
          expect(session.manager.getStatus("member").state).toBe("ready");
          await marker("observer", "OWNER_STOP");
          await session.manager.startService("owner");
          expect(session.manager.getStatus("owner").state).toBe("ready");
          await session.manager.restartService("member");
          expect(session.manager.getStatus("member").state).toBe("ready");
          await marker("observer", "MEMBER_RESTART");
          await session.manager.stopService("member");
          expect(session.manager.getStatus("owner").state).toBe("ready");
          await session.manager.startService("member");
          expect(session.manager.getStatus("member").state).toBe("ready");
          expect(await ids()).toEqual(initialIds);
          expect(start).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
          expect(session.manager.getStatus("owner").pid).toBe(producerPid);
          for (const name of ["owner", "member"]) {
            const config = structuredClone(session.config.project.services[name].docker);
            const statuses = structuredClone(session.manager.getAllStatuses());
            for (const overrides of [{}, { build: true, forceRecreate: true }]) {
              // eslint-disable-next-line no-await-in-loop -- compare each rejection before subsequent mutation
              await expect(
                session.manager.restartWithDockerOverrides(name, overrides),
              ).rejects.toMatchObject({ code: "unsupported_config" });
              // eslint-disable-next-line no-await-in-loop -- public guard must preserve the same state
              const response = await ipcRequest(
                fixture.socketPath,
                "services.rebuild",
                { name, overrides },
                5000,
                session.id,
              );
              expect(response.errorCode).toBe("unsupported_config");
              expect(session.config.project.services[name].docker).toEqual(config);
              expect(session.manager.getAllStatuses()).toEqual(statuses);
              // eslint-disable-next-line no-await-in-loop -- container identity is part of the rejection snapshot
              expect(await ids()).toEqual(initialIds);
              expect(session.logBuffers.get(name)).toBe(buffer);
              expect(start).not.toHaveBeenCalled();
              expect(stop).not.toHaveBeenCalled();
            }
          }
          await marker("observer", "REBUILD_REJECTED");
          await session.manager.stopService("observer");
          await session.manager.stopService("owner");
          expect(stop).not.toHaveBeenCalled();
          await session.manager.stopService("member");
          expect(stop).toHaveBeenCalledTimes(1);
          expect(start).not.toHaveBeenCalled();
          const [handle] = stop.mock.calls[0] ?? [];
          if (!handle) {
            throw new Error("Shared execution was not disposed");
          }
          const owned: ExecutionHandle = handle;
          expect(await runtime.isRunning(owned)).toBe(false);
          await store.destroy(session.id);
          expect(stop).toHaveBeenCalledTimes(1);
        } finally {
          unsubscribe();
        }
      } finally {
        await compose("down", "--remove-orphans", "--volumes", "--timeout", "2");
        const remaining = await compose("ps", "--all", "--quiet");
        expect(remaining.stdout.trim()).toBe("");
      }
    });
  }, 120_000);
});
