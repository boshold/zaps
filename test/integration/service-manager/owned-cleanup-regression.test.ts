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
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { TmuxRuntime, WrapperRegistry } from "#src/lib/backend/tmux/runtime.js";
import type { ExecutionEvent } from "#src/lib/backend/types.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const createdSchema = z.object({ id: z.string(), paneMap: z.record(z.string(), z.string()) });

function assertLifecycle(
  mode: string,
  events: readonly { event: ExecutionEvent; at: number }[],
): void {
  const expected: Record<string, { code: number; signal: string | null }> = {
    exit: { code: 7, signal: null },
    exit143: { code: 143, signal: null },
    term: { code: 1, signal: "SIGTERM" },
    int: { code: 1, signal: "SIGINT" },
    fast: { code: 0, signal: null },
  };
  const expectedExit = expected[mode];
  if (expectedExit) {
    const leaders = events.filter(({ event }) => event.kind === "leaderExit");
    const finals = events.filter(({ event }) => event.kind === "exit");
    expect(leaders).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(leaders[0].event).toMatchObject(expectedExit);
    expect(finals[0].event).toMatchObject(expectedExit);
    expect(finals[0].event).not.toHaveProperty("cleanupError");
    if (mode === "fast") {
      expect(finals[0].at - leaders[0].at).toBeGreaterThanOrEqual(4900);
      expect(finals[0].at - leaders[0].at).toBeLessThan(7000);
    }
  }
}

function expectedDiagnostic(mode: string): string {
  return mode === "exit" ? "FATAL" : "FINAL";
}

async function observeOwnedGroup(
  inspection: ReturnType<typeof createProcessInspection>,
  root: number,
  command: string,
): Promise<ProcessIdentity[]> {
  return vi.waitFor(
    async () => {
      const pids = await inspection.getDescendantPids(root);
      const identities = await Promise.all(
        pids.map(async (pid) => inspection.readProcessIdentity(pid)),
      );
      const member = identities.find((identity) => identity?.cmdline === command);
      if (!member) {
        throw new Error("Payload not yet started");
      }
      const members = await inspection.getProcessMembers(member);
      expect(members.length).toBeGreaterThan(1);
      return members;
    },
    { timeout: 15_000 },
  );
}

describe.skipIf(!hasTmux())("owned pane cleanup regressions", () => {
  it.each(["wrapped", "raw", "fast", "exit", "exit143", "term", "int"])(
    "cleans owned %s service, preserving pane shell",
    async (mode) => {
      const raw = mode === "raw";
      const immediate = ["exit", "exit143", "term", "int"].includes(mode);
      const previousCommand = process.env.ZAPS_COMMAND;
      process.env.ZAPS_COMMAND = path.join(projectRoot, "dist", "zaps");
      const daemon = await createTestDaemon();
      const session = await createTestSession();
      const tmux = tmuxFor(testTmuxSocket());
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-owned-cleanup-"));
      let sessionId: string | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        await tmux.setEnv(session.name, "ZAPS_SOCKET_PATH", daemon.socketPath);
        const port = await getFreePort();
        const pidFile = path.join(directory, "child.pid");
        const endings: Record<string, string> = {
          exit: 'console.error("FATAL");process.exitCode=7',
          exit143: "process.exitCode=143",
          term: 'process.kill(process.pid,"SIGTERM")',
          int: 'process.kill(process.pid,"SIGINT")',
        };
        const script = immediate
          ? `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log("FINAL");${endings[mode]}`
          : `process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});require("http").createServer((_,r)=>r.end("ok")).listen(${port},()=>{require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log("READY")})`;
        const scriptPath = path.join(directory, "child.cjs");
        const observedFile = path.join(directory, "observed");
        fs.writeFileSync(
          scriptPath,
          `function begin(){if(!require("fs").existsSync(${JSON.stringify(observedFile)})){setImmediate(begin);return;} ${script}}begin();`,
        );
        const command = `${process.execPath} ${scriptPath}`;
        const configPath = path.join(directory, ".zaps.mjs");
        let startCommand = command;
        if (raw) {
          startCommand = `sh -c '${command} &'`;
        } else if (mode === "fast") {
          startCommand = `sh -c '${command} & while [ ! -f ${pidFile} ]; do :; done'`;
        }
        fs.writeFileSync(
          configPath,
          `export const config = lib => lib.define({services:{svc:{start:${JSON.stringify(startCommand)},raw:${String(raw)},ready:{port:${String(port)}}}}});`,
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
        sessionId = view.id;
        const observed = daemon.server.get(sessionId);
        if (!observed) {
          throw new Error("Missing test session");
        }
        const events: { event: ExecutionEvent; at: number }[] = [];
        unsubscribe = observed.backend.runtime.subscribe((event) =>
          events.push({ event, at: Date.now() }),
        );
        const inspection = createProcessInspection();
        const shellPid = await tmux.panePid(view.paneMap.svc);
        const shell = await inspection.readProcessIdentity(shellPid);
        const ownedGroup = await observeOwnedGroup(inspection, shellPid, command);
        fs.writeFileSync(observedFile, "observing");
        await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 15_000 });
        const pid = z.coerce.number().int().positive().parse(fs.readFileSync(pidFile, "utf8"));
        const child = await inspection.readProcessIdentity(pid);
        if (!immediate) {
          expect(child).not.toBeNull();
        }
        expect(shell).not.toBeNull();
        if (mode === "wrapped") {
          expect(child?.sid).not.toBe(shell?.sid);
        }
        const started = Date.now();
        if (mode === "wrapped" || raw) {
          await waitForServiceState(daemon.socketPath, sessionId, "svc", "ready");
          const stopped = await ipcRequest(
            daemon.socketPath,
            "services.stop",
            { name: "svc" },
            10_000,
            sessionId,
          );
          expect(stopped.error).toBeUndefined();
        }
        await waitForServiceState(
          daemon.socketPath,
          sessionId,
          "svc",
          immediate || mode === "fast" ? "error" : "stopped",
        );
        expect(Date.now() - started).toBeLessThan(immediate ? 2500 : 7500);
        assertLifecycle(mode, events);
        if (immediate) {
          const logs = await ipcRequest(
            daemon.socketPath,
            "logs.snapshot",
            { service: "svc" },
            5000,
            sessionId,
          );
          expect(JSON.stringify(logs.result)).toContain(expectedDiagnostic(mode));
        }
        expect(await inspection.getListeningPorts([pid])).not.toContain(port);
        expect(await inspection.readProcessIdentity(pid)).toBeNull();
        const remainingGroup = await Promise.all(
          ownedGroup.map(async (member) => inspection.readProcessIdentity(member.pid)),
        );
        expect(
          remainingGroup.every(
            (current, index) => !current || !sameProcess(ownedGroup[index], current),
          ),
        ).toBe(true);
        const remainingShell = await inspection.readProcessIdentity(shellPid);
        expect(shell && remainingShell && sameProcess(shell, remainingShell)).toBe(true);
      } finally {
        unsubscribe?.();
        if (sessionId) {
          await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sessionId);
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
  it("preserves a personal pane's preexisting background job", async () => {
    const session = await createTestSession();
    const tmux = tmuxFor(testTmuxSocket());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-personal-job-"));
    const inspection = createProcessInspection();
    const previousFile = path.join(directory, "previous.pid");
    const ownedFile = path.join(directory, "owned.pid");
    const previousScript = path.join(directory, "previous.cjs");
    const ownedScript = path.join(directory, "owned.cjs");
    for (const [script, pidFile] of [
      [previousScript, previousFile],
      [ownedScript, ownedFile],
    ]) {
      fs.writeFileSync(
        script,
        `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      );
    }
    const runtime = new TmuxRuntime({
      tmux,
      processes: new ProcessRunner({ onLines: vi.fn(), onExit: vi.fn() }),
      wrappers: new WrapperRegistry(),
      paneFor: () => session.initialPaneId,
      sessionId: "personal",
      zapsCommand: "unused",
    });
    let previous: Awaited<ReturnType<typeof inspection.readProcessIdentity>> = null;
    try {
      await tmux.sendKeys(session.initialPaneId, `${process.execPath} ${previousScript} &`);
      await vi.waitFor(() => expect(fs.existsSync(previousFile)).toBe(true));
      const previousPid = z.coerce
        .number()
        .int()
        .positive()
        .parse(fs.readFileSync(previousFile, "utf8"));
      previous = await inspection.readProcessIdentity(previousPid);
      expect(previous).not.toBeNull();
      const owned = await runtime.start({
        unitId: "owned",
        generation: 1,
        command: `${process.execPath} ${ownedScript}`,
        cwd: directory,
        env: {},
        raw: true,
        placement: "default",
      });
      await vi.waitFor(() => expect(fs.existsSync(ownedFile)).toBe(true));
      const ownedPid = z.coerce.number().int().positive().parse(fs.readFileSync(ownedFile, "utf8"));
      await runtime.stop(owned);
      expect(await inspection.readProcessIdentity(ownedPid)).toBeNull();
      const remaining = await inspection.readProcessIdentity(previousPid);
      expect(previous && remaining && sameProcess(previous, remaining)).toBe(true);
    } finally {
      await runtime.dispose();
      if (previous) {
        const current = await inspection.readProcessIdentity(previous.pid);
        if (current && sameProcess(previous, current)) {
          process.kill(previous.pid, "SIGTERM");
        }
      }
      await session.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
