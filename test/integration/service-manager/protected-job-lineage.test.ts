import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const createdSchema = z.object({ id: z.string(), paneMap: z.record(z.string(), z.string()) });
const pidSchema = z.coerce.number().int().positive();

function readPid(file: string): number {
  return pidSchema.parse(fs.readFileSync(file, "utf8"));
}

describe.skipIf(!hasTmux())("protected personal job lineage", () => {
  it.each(["raw", "node", "native"])(
    "preserves future reparented worker beside %s execution",
    async (mode) => {
      const previousCommand = process.env.ZAPS_COMMAND;
      process.env.ZAPS_COMMAND = path.join(
        projectRoot,
        "dist",
        mode === "native" ? "zaps" : "cli.mjs",
      );
      const daemon = await createTestDaemon();
      const session = await createTestSession();
      const tmux = tmuxFor(testTmuxSocket());
      const inspection = createProcessInspection();
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-protected-lineage-"));
      const tracked: ProcessIdentity[] = [];
      const track = async (pid: number) => {
        const member = await inspection.readProcessIdentity(pid);
        if (!member) {
          throw new Error("Missing fixture process identity");
        }
        tracked.push(member);
        return member;
      };
      let id: string | undefined;
      try {
        await tmux.setEnv(session.name, "ZAPS_SOCKET_PATH", daemon.socketPath);
        const parentFile = path.join(directory, "parent.pid");
        const workerFile = path.join(directory, "worker.pid");
        const ownedFile = path.join(directory, "owned.pid");
        const releaseFile = path.join(directory, "fork");
        const parentScript = path.join(directory, "parent.cjs");
        const workerScript = path.join(directory, "worker.cjs");
        const ownedScript = path.join(directory, "owned.cjs");
        const port = await getFreePort();
        fs.writeFileSync(
          workerScript,
          `require("fs").writeFileSync(${JSON.stringify(workerFile)},String(process.pid));setInterval(()=>{},1000)`,
        );
        fs.writeFileSync(
          parentScript,
          `const fs=require("fs");fs.writeFileSync(${JSON.stringify(parentFile)},String(process.pid));function fork(){if(!fs.existsSync(${JSON.stringify(releaseFile)})){setImmediate(fork);return;}require("child_process").spawn(process.execPath,[${JSON.stringify(workerScript)}],{stdio:"inherit"});function done(){if(fs.existsSync(${JSON.stringify(workerFile)})){process.exit(0);}setImmediate(done);}done();}fork();`,
        );
        fs.writeFileSync(
          ownedScript,
          `process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});require("http").createServer((_,r)=>r.end("ok")).listen(${String(port)},()=>require("fs").writeFileSync(${JSON.stringify(ownedFile)},String(process.pid)))`,
        );
        const configPath = path.join(directory, ".zaps.mjs");
        fs.writeFileSync(
          configPath,
          `export const config=lib=>lib.define({services:{svc:{start:${JSON.stringify(`${process.execPath} ${ownedScript}`)},raw:${String(mode === "raw")},flags:{start:false},lazyPane:false,ready:{port:${String(port)}}}}});`,
        );
        const created = await ipcRequest(daemon.socketPath, "session.create", {
          configPath,
          projectDir: directory,
          tmuxSession: session.name,
          originPane: session.initialPaneId,
          tmuxSocket: testTmuxSocket(),
        });
        expect(created.error).toBeUndefined();
        const view = createdSchema.parse(created.result);
        ({ id } = view);
        const { svc: pane } = view.paneMap;
        const shellPid = await tmux.panePid(pane);
        const shell = await inspection.readProcessIdentity(shellPid);
        await tmux.sendKeys(pane, `${process.execPath} ${parentScript} &`);
        await vi.waitFor(() => expect(fs.existsSync(parentFile)).toBe(true));
        const parentPid = readPid(parentFile);
        const parent = await track(parentPid);
        const started = await ipcRequest(
          daemon.socketPath,
          "services.start",
          { name: "svc" },
          15_000,
          id,
        );
        expect(started.error).toBeUndefined();
        await waitForServiceState(daemon.socketPath, id, "svc", "ready");
        const ownedPid = readPid(ownedFile);
        const owned = await track(ownedPid);
        const ownedGroup = await inspection.getProcessMembers(owned);
        expect(ownedGroup.length).toBeGreaterThan(1);
        fs.writeFileSync(releaseFile, "fork");
        await vi.waitFor(() => expect(fs.existsSync(workerFile)).toBe(true));
        const workerPid = readPid(workerFile);
        const worker = await track(workerPid);
        expect(worker.pgid).toBe(parent.pgid);
        expect(worker.sid).toBe(parent.sid);
        await vi.waitFor(async () =>
          expect(await inspection.readProcessIdentity(parentPid)).toBeNull(),
        );
        const stopAt = Date.now();
        const stopped = await ipcRequest(
          daemon.socketPath,
          "services.stop",
          { name: "svc" },
          10_000,
          id,
        );
        expect(stopped.error).toBeUndefined();
        expect(Date.now() - stopAt).toBeLessThan(7500);
        expect(await inspection.readProcessIdentity(ownedPid)).toBeNull();
        const remainingGroup = await Promise.all(
          ownedGroup.map(async (member) => inspection.readProcessIdentity(member.pid)),
        );
        expect(
          remainingGroup.every(
            (current, index) => !current || !sameProcess(ownedGroup[index], current),
          ),
        ).toBe(true);
        expect(await inspection.getListeningPorts([ownedPid])).not.toContain(port);
        const surviving = await inspection.readProcessIdentity(workerPid);
        expect(surviving && sameProcess(worker, surviving)).toBe(true);
        const remainingShell = await inspection.readProcessIdentity(shellPid);
        expect(shell && remainingShell && sameProcess(shell, remainingShell)).toBe(true);
      } finally {
        for (const member of tracked) {
          // eslint-disable-next-line no-await-in-loop -- fixture cleanup never signals a reused PID
          const current = await inspection.readProcessIdentity(member.pid);
          if (current && sameProcess(member, current)) {
            process.kill(member.pid, "SIGKILL");
          }
        }
        if (id) {
          await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, id);
        }
        await daemon.cleanup();
        await session.cleanup();
        fs.rmSync(directory, { recursive: true, force: true });
        if (previousCommand === undefined) {
          delete process.env.ZAPS_COMMAND;
        } else {
          process.env.ZAPS_COMMAND = previousCommand;
        }
      }
    },
  );
});
