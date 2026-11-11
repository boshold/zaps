import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sessionHandlers } from "#src/daemon/handlers/session.js";

import { waitForCondition } from "./helpers.js";
import { withShellStore, writeServiceScript } from "./store-fixture.js";

describe("shell session logs", () => {
  it("retains no-client stdout/stderr, partial readiness and final drain exactly once", async () => {
    await withShellStore(async (fixture, store) => {
      const release = path.join(fixture.projectDir, "release");
      const hooks = path.join(fixture.projectDir, "hooks.jsonl");
      const command = writeServiceScript(
        fixture,
        "partial worker's.mjs",
        `
        import fs from 'node:fs';
        console.log('stdout');
        console.error('stderr');
        process.stdout.write('READY');
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) {
            process.stdout.write(' complete\\n');
            clearInterval(timer);
          }
        }, 10);
        setInterval(() => {}, 1000);
        process.on('SIGTERM', () => { process.stdout.write('final tail'); process.exit(0); });
      `,
      );
      fs.writeFileSync(
        fixture.configPath,
        `
        import fs from 'node:fs';
        export function config(lib) { let readyReads = 0; return lib.define({ name: 'shell-logs', services: {
          worker: { start: ${JSON.stringify(command)}, ready: { output: line => line.includes('READY') && ++readyReads >= 3 },
            onOutput: line => fs.appendFileSync(${JSON.stringify(hooks)}, JSON.stringify(line) + '\\n') }
        }}); }
      `,
      );
      const session = await store.create({
        backend: "shell",
        configPath: fixture.configPath,
        projectDir: fixture.projectDir,
        shellEnv: { ...fixture.env },
      });
      await session.startPromise;
      expect(session.manager.getStatus("worker")?.state).toBe("ready");
      expect(session.subscribers.size).toBe(0);
      const buffer = session.logBuffers.get("worker");
      if (!buffer) {
        throw new Error("Missing worker buffer");
      }
      await waitForCondition(() => buffer.length === 2 && fs.existsSync(hooks));
      expect(buffer.snapshot().toSorted()).toEqual(["stderr", "stdout"]);
      const readHooks = () =>
        fs
          .readFileSync(hooks, "utf8")
          .trim()
          .split("\n")
          .map((line) => z.string().parse(JSON.parse(line)));
      expect(readHooks().toSorted()).toEqual(["stderr", "stdout"]);
      const broadcasts = vi.spyOn(session, "broadcast");
      const subscribe = vi.spyOn(session.backend.runtime, "subscribe");
      const sockets = [new net.Socket(), new net.Socket()];
      for (const socket of sockets) {
        vi.spyOn(socket, "write").mockReturnValue(true);
        session.addSubscriber(socket);
      }
      fs.writeFileSync(release, "");
      await waitForCondition(
        () => buffer.snapshot().includes("READY complete") && readHooks().length === 3,
      );
      expect(subscribe).not.toHaveBeenCalled();
      expect(buffer.snapshot().filter((line) => line.includes("READY"))).toEqual([
        "READY complete",
      ]);
      expect(readHooks().filter((line) => line === "READY complete")).toHaveLength(1);
      expect(
        broadcasts.mock.calls
          .filter(([event]) => event.event === "log.lines")
          .map(([event]) => event.data),
      ).toEqual([{ service: "worker", lines: ["READY complete"] }]);
      for (const socket of sockets) {
        session.removeSubscriber(socket);
      }
      await session.manager.stopService("worker");
      expect(buffer.snapshot().filter((line) => line === "final tail")).toEqual(["final tail"]);
      expect(session.attachSnapshot().logSnapshots.worker).toEqual(buffer.snapshot());
      const snapshot = await sessionHandlers["logs.snapshot"](
        {
          id: "snapshot",
          method: "logs.snapshot",
          session: session.id,
          params: { service: "worker" },
        },
        store,
        sockets[0],
      );
      expect(snapshot.error).toBeUndefined();
      expect(z.array(z.string()).parse(snapshot.result)).toEqual(buffer.snapshot());
      expect(readHooks()).not.toContain("final tail");
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  });
});
