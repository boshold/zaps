/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { paneExists } from "#src/lib/tmux.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

function writeRunInPaneConfig(dir: string, port: number): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const webCmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.defineProject({",
      '    name: "test-runinpane",',
      "    services: {",
      "      web: {",
      `        start: ${JSON.stringify(webCmd)},`,
      `        ready: { port: ${port} },`,
      "        raw: true,",
      "      },",
      "    },",
      "    tasks: {",
      "      echo: {",
      '        name: "Echo",',
      '        commands: "echo run-in-pane-ok",',
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("daemon tasks.runInPane integration", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string;

  beforeEach(async () => {
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-runinpane-"));
    const port = await getFreePort();
    const configPath = writeRunInPaneConfig(tmpDir, port);
    const res = await ipcRequest(daemon.socketPath, "session.create", {
      configPath,
      projectDir: tmpDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
    });
    sid = (res.result as { id: string }).id;
  });

  afterEach(async () => {
    try {
      await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
    } catch {
      /* Best-effort cleanup */
    }
    await daemon.cleanup();
    await tmux.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a live pane, returns its id, and completes via the normal pipeline", async () => {
    const events: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["task.*"], (event) => events.push(event));
    // Confirm the subscription is live before launching.
    await ipcRequest(daemon.socketPath, "daemon.ping");

    const res = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "echo", target: "window" },
      10_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    const { runId, paneId } = res.result as { runId: string; paneId: string };
    expect(runId).toMatch(/^run_/u);
    expect(paneId).toMatch(/^%/u);

    // The pane/window is live.
    expect(await paneExists(paneId)).toBe(true);

    // Completion flows through the normal task pipeline → task.complete + runId.
    const start = Date.now();
    /* eslint-disable no-await-in-loop -- polling for the async completion event */
    let complete: DaemonEvent | undefined;
    while (Date.now() - start < 15_000) {
      complete = events.find((e) => {
        if (e.event !== "task.complete") {
          return false;
        }
        return (e.data as { runId?: string }).runId === runId;
      });
      if (complete) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    /* eslint-enable no-await-in-loop */
    sub.close();

    expect(complete).toBeDefined();
    const data = complete?.data as { key: string; result: string; runId: string };
    expect(data.key).toBe("echo");
    expect(data.result).toBe("success");

    // The pane is left open on completion (Q13) so output stays inspectable.
    expect(await paneExists(paneId)).toBe(true);
  });
});
