import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import {
  capturePane,
  getWindowName,
  getWindowOption,
  panePid,
  renameWindow,
  sendCtrlC,
  sendKeys,
  setWindowOption,
} from "#src/lib/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { composeDown, writeComposeFile } from "../helpers/docker.js";
import { hasDocker, hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

const deps = {
  sendKeys,
  sendCtrlC,
  panePid,
  detectPorts,
  capturePane,
  getDescendantPids,
  renameWindow,
  getWindowName,
  getWindowOption,
  setWindowOption,
};

describe.skipIf(!hasTmux() || !hasDocker())("docker-ready integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;
  let tmpDir: string;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort stop
    }
    if (tmpDir) {
      await composeDown(tmpDir);
      await rm(tmpDir, { recursive: true, force: true });
    }
    if (session) {
      await session.cleanup();
    }
  });

  it("detects docker container ready with redis", async () => {
    session = await createTestSession();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-docker-"));
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["redis"]);

    const composeFile = await writeComposeFile(tmpDir, {
      redis: { image: "redis:7-alpine", ports: ["0:6379"] },
    });

    const config = makeConfig({
      redis: {
        docker: { service: "redis", file: composeFile },
        cwd: tmpDir,
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startService("redis");

    expect(mgr.getStatus("redis").state).toBe("ready");
    expect(mgr.getStatus("redis").ports.length).toBeGreaterThan(0);
  });
});
