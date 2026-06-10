/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sessionId } from "#src/daemon/session.js";
import { ipcRequest, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { DaemonEvent } from "#src/lib/ipc/protocol.js";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState, writeTestConfig } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("daemon e2e", () => {
  // ── Daemon-level handlers ─────────────────────────────────────────────

  describe("daemon-level handlers", () => {
    let daemon: TestDaemon;

    beforeEach(async () => {
      daemon = await createTestDaemon();
    });

    afterEach(async () => {
      await daemon.cleanup();
    });

    it("daemon.ping returns pong", async () => {
      const res = await ipcRequest(daemon.socketPath, "daemon.ping");
      expect(res.error).toBeUndefined();
      expect(res.result).toBe("pong");
    });

    it("daemon.status returns pid and empty sessions", async () => {
      const res = await ipcRequest(daemon.socketPath, "daemon.status");
      expect(res.error).toBeUndefined();
      const status = res.result as { pid: number; sessions: unknown[] };
      expect(status.pid).toBe(process.pid);
      expect(status.sessions).toEqual([]);
    });

    it("session.list returns empty array initially", async () => {
      const res = await ipcRequest(daemon.socketPath, "session.list");
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual([]);
    });

    it("unknown method returns error", async () => {
      const res = await ipcRequest(daemon.socketPath, "nonexistent.method");
      expect(res.error).toContain("Unknown method");
    });

    it("session-scoped method without session returns error", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list");
      expect(res.error).toContain("Session required");
    });
  });

  // ── Session lifecycle ─────────────────────────────────────────────────

  describe("session lifecycle", () => {
    let daemon: TestDaemon;
    let tmux: TestSession;
    let tmpDir: string;
    let createdSessionId: string | undefined;

    beforeEach(async () => {
      daemon = await createTestDaemon();
      tmux = await createTestSession();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-e2e-"));
      createdSessionId = undefined;
    });

    afterEach(async () => {
      // Destroy session first to stop LogMonitor before killing tmux panes
      if (createdSessionId) {
        try {
          await ipcRequest(
            daemon.socketPath,
            "session.destroy",
            undefined,
            10_000,
            createdSessionId,
          );
        } catch {
          /* Best-effort cleanup */
        }
      }
      await daemon.cleanup();
      await tmux.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("session.create returns id, name, and paneMap", async () => {
      const port = await getFreePort();
      const configPath = writeTestConfig(tmpDir, port);

      const res = await ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: tmpDir,
        tmuxSession: tmux.name,
        originPane: tmux.initialPaneId,
      });
      expect(res.error).toBeUndefined();

      const data = res.result as { id: string; name: string; paneMap: Record<string, string> };
      createdSessionId = data.id;
      expect(data.id).toBe(sessionId(configPath));
      expect(data.name).toBe("test-daemon");
      expect(data.paneMap["@tui"]).toBe(tmux.initialPaneId);
      expect(data.paneMap.web).toBeDefined();

      // Verify it appears in session.list
      const listRes = await ipcRequest(daemon.socketPath, "session.list");
      const sessions = listRes.result as { id: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(data.id);
    });

    it("session.destroy removes session", async () => {
      const port = await getFreePort();
      const configPath = writeTestConfig(tmpDir, port);

      const createRes = await ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: tmpDir,
        tmuxSession: tmux.name,
        originPane: tmux.initialPaneId,
      });
      const sid = (createRes.result as { id: string }).id;

      const destroyRes = await ipcRequest(
        daemon.socketPath,
        "session.destroy",
        undefined,
        10_000,
        sid,
      );
      expect(destroyRes.error).toBeUndefined();
      expect((destroyRes.result as { destroyed: string }).destroyed).toBe(sid);

      // Session already destroyed — skip afterEach destroy
      createdSessionId = undefined;

      const listRes = await ipcRequest(daemon.socketPath, "session.list");
      expect(listRes.result).toEqual([]);
    });
  });

  // ── Session-scoped operations (shared session, ordered tests) ─────────

  describe("session operations", () => {
    let daemon: TestDaemon;
    let tmux: TestSession;
    let tmpDir: string;
    let sid: string;
    let port: number;
    let configPath: string;

    beforeAll(async () => {
      daemon = await createTestDaemon();
      tmux = await createTestSession();
      port = await getFreePort();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-e2e-"));
      configPath = writeTestConfig(tmpDir, port);

      const res = await ipcRequest(daemon.socketPath, "session.create", {
        configPath,
        projectDir: tmpDir,
        tmuxSession: tmux.name,
        originPane: tmux.initialPaneId,
      });
      sid = (res.result as { id: string }).id;

      await waitForServiceState(daemon.socketPath, sid, "web", "ready");
    });

    afterAll(async () => {
      try {
        await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
      } catch {
        /* Best-effort cleanup */
      }
      await daemon.cleanup();
      await tmux.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("services.list returns service statuses", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe("web");
      expect(statuses[0].state).toBe("ready");
    });

    it("services.details returns info with deps", async () => {
      const res = await ipcRequest(
        daemon.socketPath,
        "services.details",
        { name: "web" },
        5000,
        sid,
      );
      expect(res.error).toBeUndefined();
      const details = res.result as {
        name: string;
        state: string;
        dependsOn: string[];
        hasDocker: boolean;
      };
      expect(details.name).toBe("web");
      expect(details.state).toBe("ready");
      expect(details.dependsOn).toEqual([]);
      expect(details.hasDocker).toBe(false);
    });

    it("session.attach returns full snapshot", async () => {
      const res = await ipcRequest(daemon.socketPath, "session.attach", undefined, 5000, sid);
      expect(res.error).toBeUndefined();
      const snap = res.result as {
        id: string;
        name: string;
        paneMap: Record<string, string>;
        statuses: { name: string; state: string }[];
        configPath: string;
        projectDir: string;
        tasks: unknown[];
        servicesMeta: { name: string }[];
      };
      expect(snap.id).toBe(sid);
      expect(snap.name).toBe("test-daemon");
      expect(snap.configPath).toBe(configPath);
      expect(snap.projectDir).toBe(tmpDir);
      expect(snap.statuses).toHaveLength(1);
      expect(snap.servicesMeta).toHaveLength(1);
      expect(snap.servicesMeta[0].name).toBe("web");
    });

    it("logs.snapshot returns captured pane output", async () => {
      // Poll until LogMonitor has captured at least one line
      const start = Date.now();
      let lines: string[] = [];
      while (Date.now() - start < 10_000) {
        const res = await ipcRequest(
          daemon.socketPath,
          "logs.snapshot",
          { service: "web" },
          5000,
          sid,
        );
        if (!res.error) {
          lines = res.result as string[];
          if (lines.length > 0) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(lines.length).toBeGreaterThan(0);
    });

    it("logs.snapshot for unknown service returns error", async () => {
      const res = await ipcRequest(
        daemon.socketPath,
        "logs.snapshot",
        { service: "nope" },
        5000,
        sid,
      );
      expect(res.error).toContain("Unknown service");
    });

    it("subscribe receives stateChange events on stop", async () => {
      // Ensure service is ready first
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");

      const events: DaemonEvent[] = [];
      const sub = ipcSubscribe(daemon.socketPath, sid, ["service.stateChange"], (event) =>
        events.push(event),
      );

      // Confirm subscription is live via a ping round-trip
      await ipcRequest(daemon.socketPath, "daemon.ping");

      // Stop the service — triggers stateChange events
      await ipcRequest(daemon.socketPath, "services.stop", { name: "web" }, 10_000, sid);

      // Allow time for events to propagate
      await new Promise((resolve) => setTimeout(resolve, 300));
      sub.close();

      const webEvents = events.filter((e) => {
        if (e.event !== "service.stateChange") {
          return false;
        }
        const data = e.data as { name: string };
        return data.name === "web";
      });
      expect(webEvents.length).toBeGreaterThan(0);

      // Re-start for other tests
      await ipcRequest(daemon.socketPath, "services.start", { name: "web" }, 15_000, sid);
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");
    });

    it("services.stop + start transitions service back to ready", async () => {
      // Ensure service is ready first
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");

      // Stop
      const stopRes = await ipcRequest(
        daemon.socketPath,
        "services.stop",
        { name: "web" },
        10_000,
        sid,
      );
      expect(stopRes.error).toBeUndefined();
      await waitForServiceState(daemon.socketPath, sid, "web", "stopped");

      // Start
      const startRes = await ipcRequest(
        daemon.socketPath,
        "services.start",
        { name: "web" },
        15_000,
        sid,
      );
      expect(startRes.error).toBeUndefined();
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");
    });

    it("services.restart cycles the service back to ready", async () => {
      // Ensure service is ready first
      await waitForServiceState(daemon.socketPath, sid, "web", "ready");

      const res = await ipcRequest(
        daemon.socketPath,
        "services.restart",
        { name: "web" },
        15_000,
        sid,
      );
      expect(res.error).toBeUndefined();

      await waitForServiceState(daemon.socketPath, sid, "web", "ready");
    });

    it("concurrent IPC requests all resolve correctly", async () => {
      const requests = Array.from({ length: 10 }, async () =>
        ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sid),
      );
      const results = await Promise.all(requests);

      for (const res of results) {
        expect(res.error).toBeUndefined();
        const statuses = res.result as { name: string; state: string }[];
        expect(statuses).toHaveLength(1);
        expect(statuses[0].name).toBe("web");
      }
    });
  });

  // ── Validation errors ─────────────────────────────────────────────

  describe("config validation errors", () => {
    let daemon: TestDaemon;
    let tmux: TestSession;

    beforeEach(async () => {
      daemon = await createTestDaemon();
      tmux = await createTestSession();
    });

    afterEach(async () => {
      await daemon.cleanup();
      await tmux.cleanup();
    });

    it("session.create with nonexistent config returns error", async () => {
      const res = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: "/tmp/nonexistent-zaps-config.mjs",
        projectDir: "/tmp",
        tmuxSession: tmux.name,
        originPane: tmux.initialPaneId,
      });
      expect(res.error).toBeDefined();
    });
  });
});
