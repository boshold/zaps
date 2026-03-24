/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ipcRequest } from "#src/lib/ipc/client.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestDaemon } from "../helpers/daemon.js";
import { createTestDaemon, waitForServiceState, writeTestConfig } from "../helpers/daemon.js";
import { getFreePort } from "../helpers/port.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("daemon multi-session", () => {
  // ── Two sessions coexist on same daemon ──────────────────────────────

  describe("two sessions coexist on same daemon", () => {
    let daemon: TestDaemon;
    let tmux1: TestSession;
    let tmux2: TestSession;
    let tmpDir1: string;
    let tmpDir2: string;
    let sidA: string | undefined;
    let sidB: string | undefined;

    beforeAll(async () => {
      daemon = await createTestDaemon();
      tmux1 = await createTestSession();
      tmux2 = await createTestSession();
      tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-a-"));
      tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-b-"));

      const portA = await getFreePort();
      const portB = await getFreePort();
      const configA = writeTestConfig(tmpDir1, portA);
      const configB = writeTestConfig(tmpDir2, portB);

      const resA = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configA,
        projectDir: tmpDir1,
        tmuxSession: tmux1.name,
        originPane: tmux1.initialPaneId,
      });
      sidA = (resA.result as { id: string }).id;

      const resB = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configB,
        projectDir: tmpDir2,
        tmuxSession: tmux2.name,
        originPane: tmux2.initialPaneId,
      });
      sidB = (resB.result as { id: string }).id;

      await Promise.all([
        waitForServiceState(daemon.socketPath, sidA, "web", "ready"),
        waitForServiceState(daemon.socketPath, sidB, "web", "ready"),
      ]);
    });

    afterAll(async () => {
      for (const sid of [sidA, sidB]) {
        if (sid) {
          try {
            await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
          } catch {
            /* Best-effort */
          }
        }
      }
      await daemon.cleanup();
      await tmux1.cleanup();
      await tmux2.cleanup();
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });

    it("session.list returns both sessions", async () => {
      const res = await ipcRequest(daemon.socketPath, "session.list");
      expect(res.error).toBeUndefined();
      const sessions = res.result as { id: string }[];
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(sidA);
      expect(ids).toContain(sidB);
    });

    it("session A's web service is ready", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sidA);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses.find((s) => s.name === "web")?.state).toBe("ready");
    });

    it("session B's web service is ready", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sidB);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses.find((s) => s.name === "web")?.state).toBe("ready");
    });
  });

  // ── Stopping a service in session A doesn't affect session B ─────────

  describe("stopping service in session A doesn't affect session B", () => {
    let daemon: TestDaemon;
    let tmux1: TestSession;
    let tmux2: TestSession;
    let tmpDir1: string;
    let tmpDir2: string;
    let sidA: string;
    let sidB: string;

    beforeAll(async () => {
      daemon = await createTestDaemon();
      tmux1 = await createTestSession();
      tmux2 = await createTestSession();
      tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-a-"));
      tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-b-"));

      const portA = await getFreePort();
      const portB = await getFreePort();
      const configA = writeTestConfig(tmpDir1, portA);
      const configB = writeTestConfig(tmpDir2, portB);

      const resA = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configA,
        projectDir: tmpDir1,
        tmuxSession: tmux1.name,
        originPane: tmux1.initialPaneId,
      });
      sidA = (resA.result as { id: string }).id;

      const resB = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configB,
        projectDir: tmpDir2,
        tmuxSession: tmux2.name,
        originPane: tmux2.initialPaneId,
      });
      sidB = (resB.result as { id: string }).id;

      await Promise.all([
        waitForServiceState(daemon.socketPath, sidA, "web", "ready"),
        waitForServiceState(daemon.socketPath, sidB, "web", "ready"),
      ]);

      await ipcRequest(daemon.socketPath, "services.stop", { name: "web" }, 10_000, sidA);
      await waitForServiceState(daemon.socketPath, sidA, "web", "stopped");
    });

    afterAll(async () => {
      for (const sid of [sidA, sidB]) {
        if (sid) {
          try {
            await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sid);
          } catch {
            /* Best-effort */
          }
        }
      }
      await daemon.cleanup();
      await tmux1.cleanup();
      await tmux2.cleanup();
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });

    it("session A's web service is stopped", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sidA);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses.find((s) => s.name === "web")?.state).toBe("stopped");
    });

    it("session B's web service is still ready", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sidB);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses.find((s) => s.name === "web")?.state).toBe("ready");
    });
  });

  // ── Destroying session A doesn't affect session B ─────────────────────

  describe("destroying session A doesn't affect session B", () => {
    let daemon: TestDaemon;
    let tmux1: TestSession;
    let tmux2: TestSession;
    let tmpDir1: string;
    let tmpDir2: string;
    let sidA: string;
    let sidB: string;

    beforeAll(async () => {
      daemon = await createTestDaemon();
      tmux1 = await createTestSession();
      tmux2 = await createTestSession();
      tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-a-"));
      tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-multi-b-"));

      const portA = await getFreePort();
      const portB = await getFreePort();
      const configA = writeTestConfig(tmpDir1, portA);
      const configB = writeTestConfig(tmpDir2, portB);

      const resA = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configA,
        projectDir: tmpDir1,
        tmuxSession: tmux1.name,
        originPane: tmux1.initialPaneId,
      });
      sidA = (resA.result as { id: string }).id;

      const resB = await ipcRequest(daemon.socketPath, "session.create", {
        configPath: configB,
        projectDir: tmpDir2,
        tmuxSession: tmux2.name,
        originPane: tmux2.initialPaneId,
      });
      sidB = (resB.result as { id: string }).id;

      await Promise.all([
        waitForServiceState(daemon.socketPath, sidA, "web", "ready"),
        waitForServiceState(daemon.socketPath, sidB, "web", "ready"),
      ]);

      await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sidA);
    });

    afterAll(async () => {
      try {
        await ipcRequest(daemon.socketPath, "session.destroy", undefined, 10_000, sidB);
      } catch {
        /* Best-effort */
      }
      await daemon.cleanup();
      await tmux1.cleanup();
      await tmux2.cleanup();
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });

    it("session.list returns only session B", async () => {
      const res = await ipcRequest(daemon.socketPath, "session.list");
      expect(res.error).toBeUndefined();
      const sessions = res.result as { id: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(sidB);
    });

    it("session B's web service is still ready", async () => {
      const res = await ipcRequest(daemon.socketPath, "services.list", undefined, 5000, sidB);
      expect(res.error).toBeUndefined();
      const statuses = res.result as { name: string; state: string }[];
      expect(statuses.find((s) => s.name === "web")?.state).toBe("ready");
    });
  });
});
