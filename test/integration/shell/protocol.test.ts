import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DaemonClient } from "#src/client/daemon-client.js";
import {
  ipcErrorResponseSchema,
  sessionCreatedSchema,
  sessionListEntrySchema,
} from "#src/lib/backend/schemas.js";
import {
  parseDaemonStatus,
  projectedStatusSchema,
  unavailableActions,
} from "#src/lib/backend/wire.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { runWithEnvironment } from "#src/lib/request-context.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore, writeServiceScript } from "./store-fixture.js";

describe("shell public IPC", () => {
  it("creates, reuses, controls, streams, reloads and destroys without tmux", async () => {
    await withShellStore(async (fixture, store) => {
      const configPath = path.join(fixture.projectDir, ".zaps.mts");
      const command = writeServiceScript(
        fixture,
        "worker.mjs",
        "console.log('WIRE_READY'); setInterval(() => console.log('WIRE_FOLLOW'), 100);",
      );
      const releasePath = path.join(fixture.projectDir, "release-task");
      const taskCommand = writeServiceScript(
        fixture,
        "task.mjs",
        `import fs from 'node:fs'; console.log('TASK_WAIT');
        const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); console.log('TASK_DONE'); } }, 25);`,
      );
      const config = (
        raw = false,
      ) => `export function config(lib) { return lib.define({ name: 'wire', services: {
        worker: { start: ${JSON.stringify(command)}, ready: { output: /WIRE_READY/ }, raw: ${raw} },
        disabled: { start: 'exit 99', flags: { start: false } }
      }, tasks: { hello: { name: 'Hello', commands: 'echo TASK_WIRE' }, hold: { name: 'Hold', commands: ${JSON.stringify(taskCommand)} } } }); }`;
      fs.writeFileSync(configPath, config());
      await store.start(fixture.socketPath);
      const params = { backend: "shell", configPath, projectDir: fixture.projectDir };
      const request = async (method: string, data?: unknown, session?: string) =>
        runWithEnvironment(
          { ...fixture.env, TMUX: "/hostile/host,1,0", TMUX_PANE: "%999" },
          async () => ipcRequest(fixture.socketPath, method, data, 30_000, session),
        );
      const statusResponse = await request("daemon.status");
      const status = parseDaemonStatus(statusResponse.result);
      expect(status.supportedBackends).toEqual(["tmux", "shell"]);
      for (const fields of [
        { tmuxSession: "main" },
        { originPane: "%0" },
        { tmuxSocket: null },
        { managedTmux: false },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- serial protocol assertions
        expect(
          ipcErrorResponseSchema.parse(await request("session.create", { ...params, ...fields }))
            .errorCode,
        ).toBe("invalid_request");
      }
      expect(
        ipcErrorResponseSchema.parse(
          await request("session.create", { ...params, backend: "unknown" }),
        ).errorCode,
      ).toBe("invalid_backend");
      expect(store.sessionCount).toBe(0);
      const createdResponse = await request("session.create", params);
      const created = sessionCreatedSchema.parse(createdResponse.result);
      expect(created).toMatchObject({ backend: "shell", paneMap: {} });
      expect(created).not.toHaveProperty("focusPane");
      const session = store.get(created.id);
      if (!session) {
        throw new Error("Public create did not register a session");
      }
      await session.startPromise;
      const { pid } = session.manager.getStatus("worker");
      expect(pid).toBeGreaterThan(0);
      expect(session.manager.getStatus("disabled").state).toBe("stopped");
      const reusedResponse = await request("session.create", params);
      expect(sessionCreatedSchema.parse(reusedResponse.result).id).toBe(created.id);
      await request("services.startAll", undefined, created.id);
      expect(session.manager.getStatus("worker").pid).toBe(pid);
      const listResponse = await request("session.list");
      const rows = z.array(sessionListEntrySchema).parse(listResponse.result);
      expect(rows[0]).toMatchObject({ backend: "shell" });
      expect(rows[0]).not.toHaveProperty("tmuxSession");
      expect(
        ipcErrorResponseSchema.parse(
          await request("session.create", {
            ...params,
            backend: "tmux",
            tmuxSession: "main",
            originPane: "%0",
          }),
        ).errorCode,
      ).toBe("backend_conflict");
      const client = new DaemonClient(fixture.socketPath, created.id, { daemonStatus: status });
      try {
        const snapshot = await client.attach();
        expect(snapshot.backend).toBe("shell");
        expect(snapshot).not.toHaveProperty("managed");
        expect(snapshot.statuses.find((item) => item.name === "worker")).toMatchObject({
          actions: unavailableActions,
        });
        expect(snapshot.statuses.find((item) => item.name === "worker")?.isDetached).not.toBe(true);
        const statuses = await client.listServices();
        expect(projectedStatusSchema.parse(statuses[0]).actions).toEqual(unavailableActions);
        expect(await client.serviceDetails("worker")).toMatchObject({
          dependsOn: [],
          hasDocker: false,
        });
        expect(await client.getLogSnapshot("worker")).toContain("WIRE_READY");
        client.connect();
        await client.bindUi();
        const followed: string[] = [];
        client.on("log.lines", (_service, lines: string[]) => followed.push(...lines));
        await waitForCondition(() => followed.includes("WIRE_FOLLOW"));
        await expect(
          client.terminalAction({ action: "focus", target: { kind: "service", name: "worker" } }),
        ).rejects.toMatchObject({ code: "unsupported_capability" });
        expect(
          ipcErrorResponseSchema.parse(
            await request("tasks.runInPane", { key: "hello" }, created.id),
          ).errorCode,
        ).toBe("unsupported_capability");
        const lines: string[] = [];
        expect(await client.runTask("hello", { onLine: (line) => lines.push(line) })).toMatchObject(
          { success: true },
        );
        expect(lines).toContain("TASK_WIRE");
        expect(session.taskHistory.filter((item) => item.taskKey === "hello")).toHaveLength(1);
        const heldLines: string[] = [];
        const held = client.runTask("hold", { onLine: (line) => heldLines.push(line) });
        await waitForCondition(() => heldLines.includes("TASK_WAIT"));
        await client.detach({ detachHost: true });
        fs.writeFileSync(releasePath, "release");
        expect(await held).toMatchObject({ success: true });
        expect(heldLines).toContain("TASK_DONE");
        expect(session.taskHistory.filter((item) => item.taskKey === "hold")).toHaveLength(1);
        expect(client.uiBound).toBe(false);
        expect(session.manager.getStatus("worker").pid).toBe(pid);
        await client.stopService("worker");
        await client.startService("worker");
        await client.restartService("worker");
        const retainedPid = session.manager.getStatus("worker").pid;
        fs.writeFileSync(configPath, config(true));
        await expect(client.reloadConfig()).rejects.toMatchObject({ code: "unsupported_config" });
        expect(session.manager.getStatus("worker").pid).toBe(retainedPid);
        fs.writeFileSync(configPath, config());
        client.connect();
        await client.bindUi();
        const reloads: unknown[] = [];
        client.on("session.configReloaded", (value) => reloads.push(value));
        await client.reloadConfig();
        await waitForCondition(() => reloads.length === 1);
        expect(reloads[0]).toMatchObject({ backend: "shell", paneMap: {} });
        await client.destroySession();
        expect(store.hasOwnedWork).toBe(false);
      } finally {
        client.disconnect();
      }
    });
  });
});
