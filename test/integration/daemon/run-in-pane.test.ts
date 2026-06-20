/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipcRequest, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";
import { paneExists, setEnv } from "#src/lib/tmux.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const localZaps = path.join(projectRoot, "bin", "zaps");

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
      // Emits 3 lines with NO trailing newline — the last line is a tail chunk
      // That stays in the wrapper's line buffer until flush(). Exercises the
      // Close-vs-exit ordering: 'exit' could fire before the final 'data', losing
      // The tail; 'close' guarantees all stdio delivered first.
      "      tail: {",
      '        name: "Tail",',
      "        commands: `printf 'tail-1",
      "tail-2",
      "tail-3'`,",
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("daemon tasks.runInPane integration (exec-task wrapper)", () => {
  let daemon: TestDaemon;
  let tmux: TestSession;
  let tmpDir: string;
  let sid: string;

  beforeEach(async () => {
    // The daemon builds the pane command from ZAPS_COMMAND; the wrapper inside the
    // Pane finds the test daemon via ZAPS_SOCKET_PATH (set on the tmux session).
    process.env.ZAPS_COMMAND = localZaps;
    daemon = await createTestDaemon();
    tmux = await createTestSession();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-runinpane-"));
    await setEnv(tmux.name, "ZAPS_SOCKET_PATH", daemon.socketPath);
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
    delete process.env.ZAPS_COMMAND;
  });

  it("runs the task via the wrapper, captures output, completes, and leaves the pane open", async () => {
    const events: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["task.*"], (event) => events.push(event));
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

    // Completion flows from the wrapper's exit report (no tmux wait-for). Allow a
    // Generous window — the wrapper may cold-start the CLI via tsx.
    const start = Date.now();
    /* eslint-disable no-await-in-loop -- polling for the async completion event */
    let complete: DaemonEvent | undefined;
    while (Date.now() - start < 30_000) {
      complete = events.find(
        (e) => e.event === "task.complete" && (e.data as { runId?: string }).runId === runId,
      );
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

    // The captured output is retrievable post-mortem via tasks.output (AC3 gap closed).
    const outRes = await ipcRequest(daemon.socketPath, "tasks.output", { runId }, 5000, sid);
    expect(outRes.error).toBeUndefined();
    const out = outRes.result as { result: string; lines: string[] };
    expect(out.result).toBe("success");
    expect(out.lines.join("\n")).toContain("run-in-pane-ok");

    // The pane is left open on completion (Q13) so output stays inspectable.
    expect(await paneExists(paneId)).toBe(true);
  });

  it("captures the trailing line of multi-line, no-trailing-newline output (tail-chunk race)", async () => {
    const events: DaemonEvent[] = [];
    const sub = ipcSubscribe(daemon.socketPath, sid, ["task.*"], (event) => events.push(event));
    await ipcRequest(daemon.socketPath, "daemon.ping");

    const res = await ipcRequest(
      daemon.socketPath,
      "tasks.runInPane",
      { key: "tail", target: "window" },
      10_000,
      sid,
    );
    expect(res.error).toBeUndefined();
    const { runId } = res.result as { runId: string };

    const start = Date.now();
    /* eslint-disable no-await-in-loop -- polling for the async completion event */
    let complete: DaemonEvent | undefined;
    while (Date.now() - start < 30_000) {
      complete = events.find(
        (e) => e.event === "task.complete" && (e.data as { runId?: string }).runId === runId,
      );
      if (complete) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    /* eslint-enable no-await-in-loop */
    sub.close();

    expect(complete).toBeDefined();

    // All three lines must survive — including the trailing "tail-3" with no
    // Newline, which only finishing on 'close' (not 'exit') guarantees.
    const outRes = await ipcRequest(daemon.socketPath, "tasks.output", { runId }, 5000, sid);
    expect(outRes.error).toBeUndefined();
    const out = outRes.result as { lines: string[] };
    expect(out.lines).toContain("tail-1");
    expect(out.lines).toContain("tail-2");
    expect(out.lines).toContain("tail-3");
  });
});
