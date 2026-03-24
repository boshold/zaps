import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ServiceManager } from "#src/lib/service/manager.js";
import { splitPane } from "#src/lib/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { composeDown, writeComposeFile } from "../helpers/docker.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasDocker, hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

const execFileAsync = promisify(execFile);

const deps = {
  ...tmuxDeps,
  exec: async (cmd: string, args: string[], cwd?: string) => {
    await execFileAsync(cmd, args, cwd ? { cwd } : {});
  },
};

describe.skipIf(!hasTmux() || !hasDocker())("docker expand integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;
  let tmpDir: string;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      /* Best-effort stop */
    }
    if (tmpDir) {
      await composeDown(tmpDir);
      await rm(tmpDir, { recursive: true, force: true });
    }
    if (session) {
      await session.cleanup();
    }
  });

  it("expanded services share a pane and reach ready independently", async () => {
    session = await createTestSession();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-expand-"));

    const composeFile = await writeComposeFile(tmpDir, {
      redis: { image: "redis:7-alpine", ports: ["0:6379"] },
      memcached: { image: "memcached:1-alpine", ports: ["0:11211"] },
    });

    // Create a separate pane for the combined services (not the @tui pane)
    const sharedPaneId = await splitPane(session.initialPaneId, "v");
    const paneMap: Record<string, string> = {
      "@tui": session.initialPaneId,
      redis: sharedPaneId,
      memcached: sharedPaneId,
    };

    const config = makeConfig({
      redis: {
        docker: { service: "redis", file: composeFile },
        cwd: tmpDir,
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: true },
      },
      memcached: {
        docker: { service: "memcached", file: composeFile },
        cwd: tmpDir,
        dependsOn: ["redis"],
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: false },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();

    expect(mgr.getStatus("redis").state).toBe("ready");
    expect(mgr.getStatus("memcached").state).toBe("ready");
    expect(mgr.getStatus("redis").group).toBe("cache");
    expect(mgr.getStatus("memcached").group).toBe("cache");
    expect(mgr.getStatus("redis").ports.length).toBeGreaterThan(0);
    expect(mgr.getStatus("memcached").ports.length).toBeGreaterThan(0);
  });

  it("stops individual container without killing pane", async () => {
    session = await createTestSession();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-expand-"));

    const composeFile = await writeComposeFile(tmpDir, {
      redis: { image: "redis:7-alpine", ports: ["0:6379"] },
      memcached: { image: "memcached:1-alpine", ports: ["0:11211"] },
    });

    const sharedPaneId = await splitPane(session.initialPaneId, "v");
    const paneMap: Record<string, string> = {
      "@tui": session.initialPaneId,
      redis: sharedPaneId,
      memcached: sharedPaneId,
    };

    const config = makeConfig({
      redis: {
        docker: { service: "redis", file: composeFile },
        cwd: tmpDir,
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: true },
      },
      memcached: {
        docker: { service: "memcached", file: composeFile },
        cwd: tmpDir,
        dependsOn: ["redis"],
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: false },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();

    // Stop memcached only — redis should remain ready
    await mgr.stopService("memcached");

    expect(mgr.getStatus("memcached").state).toBe("stopped");
    expect(mgr.getStatus("redis").state).toBe("ready");
  });

  it("restarts individual container in group", async () => {
    session = await createTestSession();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-expand-"));

    const composeFile = await writeComposeFile(tmpDir, {
      redis: { image: "redis:7-alpine", ports: ["0:6379"] },
      memcached: { image: "memcached:1-alpine", ports: ["0:11211"] },
    });

    const sharedPaneId = await splitPane(session.initialPaneId, "v");
    const paneMap: Record<string, string> = {
      "@tui": session.initialPaneId,
      redis: sharedPaneId,
      memcached: sharedPaneId,
    };

    const config = makeConfig({
      redis: {
        docker: { service: "redis", file: composeFile },
        cwd: tmpDir,
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: true },
      },
      memcached: {
        docker: { service: "memcached", file: composeFile },
        cwd: tmpDir,
        dependsOn: ["redis"],
        _combined: { group: "cache", allServices: ["redis", "memcached"], isOwner: false },
      },
    });

    mgr = new ServiceManager(config, paneMap, deps, session.name);
    await mgr.startAll();

    // Restart memcached — should use docker compose restart
    await mgr.restartService("memcached");

    expect(mgr.getStatus("memcached").state).toBe("ready");
    expect(mgr.getStatus("redis").state).toBe("ready");
  });
});
