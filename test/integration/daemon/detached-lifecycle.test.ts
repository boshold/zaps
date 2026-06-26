/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest } from "#src/lib/ipc/client.js";
import { getDescendantPids } from "#src/lib/port.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

/**
 * Write a config with a single DETACHED service: a pane-less HTTP server that
 * also prints a tick line periodically so logs can be observed (E4).
 */
function writeDetachedConfig(dir: string, port: number): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const cmd = `node -e "let n=0;const s=require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')});s.listen(${port},()=>console.log('listening on ${port}'));setInterval(()=>console.log('tick '+(n++)),200)"`;
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.define({",
      '    name: "test-detached",',
      "    services: {",
      "      worker: {",
      `        start: ${JSON.stringify(cmd)},`,
      "        detached: true,",
      `        ready: { port: ${port} },`,
      "        restart: { maxRetries: 3, backoff: 200 },",
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("detached service lifecycle (E4)", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string | undefined;

  beforeEach(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-detached-"));
    sid = undefined;
  });

  afterEach(async () => {
    if (sid) {
      try {
        await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
      } catch {
        /* Best-effort */
      }
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts pane-less, exposes logs, restarts on crash, and stops cleanly", async () => {
    const port = await getFreePort();
    const configPath = writeDetachedConfig(tmpDir, port);

    const createRes = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    expect(createRes.error).toBeUndefined();
    sid = (createRes.result as { id: string }).id;

    await waitForServiceState(daemon.socketPath, sid, "worker", "ready");

    // 1. No pane was created for the detached service.
    const snap = await ipcRequest(daemon.socketPath, "session.attach", undefined, 5000, sid);
    const { paneMap } = snap.result as { paneMap: Record<string, string> };
    expect(paneMap.worker).toBeUndefined();

    // 2. Capture the live child PID for crash + stop assertions.
    const listRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    const statuses = listRes.result as { name: string; pid?: number; ports: number[] }[];
    const worker = statuses.find((s) => s.name === "worker");
    expect(worker?.ports).toContain(port);

    // 3. Logs are visible via `logs.snapshot` (the same path as `zaps logs`).
    const logsRes = await ipcRequest(
      daemon.socketPath,
      "logs.snapshot",
      { service: "worker" },
      5000,
      sid,
    );
    const lines = logsRes.result as string[];
    expect(lines.some((l) => l.includes("listening") || l.startsWith("tick"))).toBe(true);

    // 4. Kill the child's process group → crash-restart with backoff.
    const before = statuses.find((s) => s.name === "worker");
    const pid = before?.pid;
    if (typeof pid === "number") {
      const descendants = await getDescendantPids(pid);
      for (const p of descendants) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* Already gone */
        }
      }
    }
    // The crash monitor sees the exit and drives it back to ready.
    await waitForServiceState(daemon.socketPath, sid, "worker", "ready", 20_000);

    // 5. Stop → the process group is fully gone.
    const afterRes = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
    const afterRestart = afterRes.result as { name: string; pid?: number }[];
    const newPid = afterRestart.find((s) => s.name === "worker")?.pid;
    await ipcRequest(daemon.socketPath, "services.stop", { name: "worker" }, 10_000, sid);
    await waitForServiceState(daemon.socketPath, sid, "worker", "stopped");

    if (typeof newPid === "number") {
      const descendants = await getDescendantPids(newPid);
      const survivors = descendants.filter((p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(survivors).toHaveLength(0);
    }
  });
});
