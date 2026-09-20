import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ipcRequest } from "#src/lib/ipc/client.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("project request context", () => {
  let daemon: TestDaemon;
  let tmuxA: TestSession;
  let tmuxB: TestSession;
  let root: string;
  let sessionA: string;
  let sessionB: string;
  let portA: number;
  let portB: number;

  beforeAll(async () => {
    daemon = await createTestDaemon();
    tmuxA = await createTestSession();
    tmuxB = await createTestSession();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-project-context-"));
    const projectA = path.join(root, "a");
    const projectB = path.join(root, "b");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    portA = await getFreePort();
    portB = await getFreePort();
    fs.writeFileSync(path.join(projectA, ".env"), `PROJECT_VALUE=a\nPORT=${portA}\n`);
    fs.writeFileSync(path.join(projectB, ".env"), `PROJECT_VALUE=b\nPORT=${portB}\n`);

    const configPath = path.join(root, ".zaps.mjs");
    const command =
      `node -e "require('http').createServer((_,r)=>r.end(process.env.PROJECT_VALUE))` +
      `.listen(Number(process.env.PORT))"`;
    fs.writeFileSync(
      configPath,
      `export function config({ define }) {
        const port = Number(process.env.PORT ?? "1");
        return define({
          cwd: ({ invokeDir }) => invokeDir,
          services: {
            web: {
              raw: true,
              start: ${JSON.stringify(command)},
              ready: { port },
            },
          },
        });
      }`,
    );

    const [createdA, createdB] = await Promise.all([
      ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: projectA,
        resolvedProjectDir: projectA,
        tmuxSession: tmuxA.name,
        originPane: tmuxA.initialPaneId,
        tmuxSocket: testTmuxSocket(),
      }),
      ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: projectB,
        resolvedProjectDir: projectB,
        tmuxSession: tmuxB.name,
        originPane: tmuxB.initialPaneId,
        tmuxSocket: testTmuxSocket(),
      }),
    ]);
    sessionA = (createdA.result as { id: string }).id;
    sessionB = (createdB.result as { id: string }).id;
    await Promise.all([
      waitForServiceState(daemon.socketPath, sessionA, "web", "ready"),
      waitForServiceState(daemon.socketPath, sessionB, "web", "ready"),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sessionA),
      ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sessionB),
    ]).catch(() => undefined);
    await daemon.cleanup();
    await tmuxA.cleanup();
    await tmuxB.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("isolates two project roots behind one daemon and shared config", async () => {
    expect(sessionA).not.toBe(sessionB);
    await expect(fetch(`http://127.0.0.1:${portA}`).then(async (res) => res.text())).resolves.toBe(
      "a",
    );
    await expect(fetch(`http://127.0.0.1:${portB}`).then(async (res) => res.text())).resolves.toBe(
      "b",
    );
  });
});
