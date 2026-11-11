import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { createRawPaneLaunch } from "#src/lib/backend/tmux/raw-launch.js";
import type { RawPaneLaunch } from "#src/lib/backend/tmux/raw-launch.js";
import { TmuxRuntime, WrapperRegistry } from "#src/lib/backend/tmux/runtime.js";
import { tmuxFor } from "#src/lib/tmux.js";

import { hasTmux } from "../helpers/skip.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

async function fixture() {
  const session = await createTestSession();
  const tmux = tmuxFor(testTmuxSocket());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-raw-contract-"));
  const launches: RawPaneLaunch[] = [];
  const holders: number[] = [];
  const runtime = new TmuxRuntime({
    tmux,
    processes: new ProcessRunner({ onLines: vi.fn(), onExit: vi.fn() }),
    wrappers: new WrapperRegistry(),
    sessionId: "raw-contract",
    zapsCommand: "unused",
    paneFor: () => session.initialPaneId,
    rawLaunch: (command, active, shell) => {
      const launch = createRawPaneLaunch(command, active, shell);
      launches.push(launch);
      const { holder } = launch;
      vi.spyOn(launch, "holder").mockImplementation(async () => {
        const pid = await holder();
        holders.push(pid);
        return pid;
      });
      return launch;
    },
  });
  const start = async (body: string) => {
    const script = path.join(directory, "payload.cjs");
    fs.writeFileSync(script, body);
    return runtime.start({
      unitId: "raw",
      generation: 1,
      command: `${process.execPath} ${script}`,
      cwd: directory,
      env: { CUSTOM_RAW: "preserved" },
      raw: true,
      placement: "default",
    });
  };
  return {
    session,
    tmux,
    directory,
    launches,
    holders,
    runtime,
    start,
    async cleanup() {
      await runtime.dispose().catch(() => {
        /* Assertions retain cleanup failure. */
      });
      for (const launch of launches) {
        launch.dispose();
      }
      await session.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!hasTmux())("raw launch contract", () => {
  it("preserves terminal stdin, cwd, environment and closes control descriptors", async () => {
    const f = await fixture();
    const ready = path.join(f.directory, "ready.json");
    const input = path.join(f.directory, "input");
    try {
      const handle = await f.start(
        `const fs=require("fs");const links=process.platform==="linux"?fs.readdirSync("/proc/self/fd").flatMap(fd=>{try{return[fs.readlinkSync("/proc/self/fd/"+fd)]}catch{return[]}}):[];fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,tty:process.stdin.isTTY,cwd:process.cwd(),env:process.env.CUSTOM_RAW,links}));process.stdin.setEncoding("utf8");process.stdin.once("data",value=>fs.writeFileSync(${JSON.stringify(input)},value));setInterval(()=>{},1000)`,
      );
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
      const state = z
        .object({
          pid: z.number().int().positive(),
          tty: z.boolean(),
          cwd: z.string(),
          env: z.string(),
          links: z.array(z.string()),
        })
        .parse(JSON.parse(fs.readFileSync(ready, "utf8")));
      expect(state).toMatchObject({ tty: true, cwd: f.directory, env: "preserved" });
      expect(state.links.some((link) => link.includes("zaps-pane-launch-"))).toBe(false);
      await f.tmux.sendKeys(f.session.initialPaneId, "raw stdin preserved");
      await vi.waitFor(() =>
        expect(fs.readFileSync(input, "utf8").trim()).toBe("raw stdin preserved"),
      );
      await f.runtime.stop(handle);
      const inspection = createProcessInspection();
      expect(await inspection.readProcessIdentity(state.pid)).toBeNull();
      for (const holder of f.holders) {
        expect(await inspection.readProcessIdentity(holder)).toBeNull();
      }
      for (const launch of f.launches) {
        expect(fs.existsSync(path.dirname(launch.file))).toBe(false);
      }
    } finally {
      await f.cleanup();
    }
  });

  it("excludes the holder from workload liveness and removes it on natural completion", async () => {
    const f = await fixture();
    const inspection = createProcessInspection();
    try {
      const handle = await f.start('console.log("RAW_FINAL")');
      await vi.waitFor(async () => expect(await f.runtime.isRunning(handle)).toBe(false));
      const started = Date.now();
      await f.runtime.stop(handle);
      expect(Date.now() - started).toBeLessThan(2500);
      for (const holder of f.holders) {
        expect(await inspection.readProcessIdentity(holder)).toBeNull();
      }
      for (const launch of f.launches) {
        expect(fs.existsSync(path.dirname(launch.file))).toBe(false);
      }
    } finally {
      await f.cleanup();
    }
  });

  it("refuses shared pane-group ownership without launching payload or interrupting a personal job", async () => {
    const f = await fixture();
    const inspection = createProcessInspection();
    const configured = path.join(f.directory, "configured");
    const personalFile = path.join(f.directory, "personal.pid");
    const payload = path.join(f.directory, "executed");
    const personalScript = path.join(f.directory, "personal.cjs");
    let personalPid: number | undefined;
    let personal: ProcessIdentity | null = null;
    try {
      execFileSync("tmux", [
        "-L",
        testTmuxSocket() ?? "invalid",
        "respawn-pane",
        "-k",
        "-t",
        f.session.initialPaneId,
        "/bin/sh -i",
      ]);
      await f.tmux.sendKeys(f.session.initialPaneId, `set +m; printf '%s\\n' "$$" > ${configured}`);
      await vi.waitFor(() => expect(fs.existsSync(configured)).toBe(true));
      fs.writeFileSync(
        personalScript,
        `require("fs").writeFileSync(${JSON.stringify(personalFile)},String(process.pid));setInterval(()=>{},1000)`,
      );
      await f.tmux.sendKeys(f.session.initialPaneId, `${process.execPath} ${personalScript} &`);
      await vi.waitFor(() => expect(fs.existsSync(personalFile)).toBe(true));
      personalPid = z.coerce.number().int().positive().parse(fs.readFileSync(personalFile, "utf8"));
      personal = await inspection.readProcessIdentity(personalPid);
      const shell = await inspection.readProcessIdentity(
        z.coerce.number().int().positive().parse(fs.readFileSync(configured, "utf8")),
      );
      expect(personal?.pgid).toBe(shell?.pgid);
      const interrupt = vi.spyOn(f.tmux, "sendCtrlC");
      await expect(
        f.start(`require("fs").writeFileSync(${JSON.stringify(payload)},"executed")`),
      ).rejects.toThrow("ownership unverifiable");
      expect(interrupt).not.toHaveBeenCalled();
      expect(fs.existsSync(payload)).toBe(false);
      const remaining = await inspection.readProcessIdentity(personalPid);
      expect(personal && remaining && sameProcess(personal, remaining)).toBe(true);
      for (const holder of f.holders) {
        await vi.waitFor(async () =>
          expect(await inspection.readProcessIdentity(holder)).toBeNull(),
        );
      }
      for (const launch of f.launches) {
        expect(fs.existsSync(path.dirname(launch.file))).toBe(false);
      }
    } finally {
      if (personal) {
        const member = await inspection.readProcessIdentity(personal.pid);
        if (member && sameProcess(personal, member)) {
          process.kill(personal.pid, "SIGKILL");
        }
      }
      await f.cleanup();
    }
  });
});
