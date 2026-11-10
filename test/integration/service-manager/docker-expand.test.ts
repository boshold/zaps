import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureEnvironment, runWithEnvironment } from "#src/lib/request-context.js";
import { ServiceManager } from "#src/lib/service/manager.js";
import { splitPane } from "#src/lib/tmux.js";

import { makeConfig } from "../helpers/config.js";
import { composeDown, writeComposeFile } from "../helpers/docker.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasDocker, hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";

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

  async function createSession(): Promise<TestSession> {
    const created = await createTestSession();
    await execFileAsync("tmux", [
      "-L",
      testTmuxSocket() ?? "zaps-test",
      "set-option",
      "-t",
      created.name,
      "default-shell",
      "/bin/sh",
    ]);
    return created;
  }

  async function startGroup(manager: ServiceManager): Promise<void> {
    await runWithEnvironment(
      captureEnvironment({
        TMPDIR: process.env.TMPDIR,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR,
        TERM: process.env.TERM,
        TERMINFO: process.env.TERMINFO,
        TERMINFO_DIRS: process.env.TERMINFO_DIRS,
        TERMCAP: process.env.TERMCAP,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        PATH: process.env.PATH ?? "",
        HOME: os.homedir(),
        ZAPS_TMUX_SOCKET: testTmuxSocket() ?? "zaps-test",
      }),
      async () => {
        await manager.startService("redis");
        await manager.startService("memcached");
      },
    );
  }

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
    session = await createSession();
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
    await startGroup(mgr);

    expect(mgr.getStatus("redis").state).toBe("ready");
    expect(mgr.getStatus("memcached").state).toBe("ready");
    expect(mgr.getStatus("redis").group).toBe("cache");
    expect(mgr.getStatus("memcached").group).toBe("cache");
    expect(mgr.getStatus("redis").ports.length).toBeGreaterThan(0);
    expect(mgr.getStatus("memcached").ports.length).toBeGreaterThan(0);
  });

  it("stops individual container without killing pane", async () => {
    session = await createSession();
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
    await startGroup(mgr);

    // Stop memcached only — redis should remain ready
    await mgr.stopService("memcached");

    expect(mgr.getStatus("memcached").state).toBe("stopped");
    expect(mgr.getStatus("redis").state).toBe("ready");
  });

  it("preserves one shared command across owner and non-owner controls", async () => {
    session = await createSession();
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

    let launches = 0;
    let disposals = 0;
    const logs = vi.fn();
    config.project.services.memcached.onOutput = logs;
    mgr = new ServiceManager(
      config,
      paneMap,
      {
        ...deps,
        runtime: (targets) => {
          const runtime = deps.runtime(targets);
          const start = runtime.start.bind(runtime);
          const stop = runtime.stop.bind(runtime);
          vi.spyOn(runtime, "start").mockImplementation(async (spec) => {
            launches += 1;
            return start(spec);
          });
          vi.spyOn(runtime, "stop").mockImplementation(async (handle) => {
            disposals += 1;
            return stop(handle);
          });
          return runtime;
        },
      },
      session.name,
    );
    await startGroup(mgr);
    const ids = async () => {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", "-f", composeFile, "ps", "-q", "memcached"],
        { cwd: tmpDir },
      );
      return stdout.trim();
    };
    const siblingId = await ids();
    expect(siblingId).not.toBe("");
    await mgr.restartService("redis");
    await mgr.stopService("redis");
    expect(mgr.getStatus("memcached").state).toBe("ready");
    expect(await ids()).toBe(siblingId);
    const logMarker = `owner-stopped-${Date.now()}`;
    await execFileAsync(
      "docker",
      [
        "compose",
        "-f",
        composeFile,
        "exec",
        "-T",
        "memcached",
        "sh",
        "-c",
        `echo ${logMarker} > /proc/1/fd/1`,
      ],
      { cwd: tmpDir },
    );
    await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(expect.stringContaining(logMarker)), {
      timeout: 10_000,
    });
    config.project.services.redis.ready = async () => {
      throw new Error("member readiness failed");
    };
    await mgr.startService("redis");
    expect(mgr.getStatus("redis")).toMatchObject({
      state: "error",
      lastError: "member readiness failed",
    });
    expect(mgr.getStatus("memcached").state).toBe("ready");
    expect(await ids()).toBe(siblingId);
    delete config.project.services.redis.ready;
    await mgr.startService("redis");
    await mgr.restartService("memcached");
    await mgr.stopService("memcached");
    await mgr.startService("memcached");
    expect(launches).toBe(1);
    expect(disposals).toBe(0);
    await mgr.stopAll();
    expect(disposals).toBe(1);
    expect(mgr.getStatus("redis").state).toBe("stopped");
    expect(mgr.getStatus("memcached").state).toBe("stopped");
  });
});
