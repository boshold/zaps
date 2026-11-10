import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { createShutdownAll } from "#src/daemon/index.js";
import { DaemonServer } from "#src/daemon/server.js";
import { runWithEnvironment } from "#src/lib/request-context.js";
import { tmuxFor } from "#src/lib/tmux.js";

it("sweeps mixed owners after failure while preserving personal hosts and unrelated private sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-shutdown-"));
  const socket = "zaps";
  const previousTmp = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = root;
  const tmux = tmuxFor(socket);
  const store = new DaemonServer();
  const names = ["managed", "personal", "unrelated"];
  let complete = false;
  await runWithEnvironment({ ...process.env, XDG_RUNTIME_DIR: root }, async () => {
    try {
      const origins = new Map<string, string>();
      for (const name of names) {
        origins.set(name, await tmux.newSession(name));
      }
      const config = (name: string) => {
        const configPath = path.join(root, `${name}.mts`);
        fs.writeFileSync(
          configPath,
          `export function config(lib) { return lib.define({name:${JSON.stringify(name)}, services:{idle:{start:"true",flags:{start:false}}}}); }`,
        );
        return configPath;
      };
      const shell = await store.create({
        backend: "shell",
        configPath: config("shell"),
        projectDir: root,
      });
      const personal = await store.create({
        backend: "tmux",
        configPath: config("personal"),
        projectDir: root,
        tmuxSession: "personal",
        originPane: origins.get("personal") ?? "",
        tmuxSocket: socket,
        managedTmux: false,
      });
      const managed = await store.create({
        backend: "tmux",
        configPath: config("managed"),
        projectDir: root,
        tmuxSession: "managed",
        originPane: origins.get("managed") ?? "",
        tmuxSocket: socket,
        managedTmux: true,
      });
      await Promise.all([shell.startPromise, personal.startPromise, managed.startPromise]);
      const destroy = vi.spyOn(store, "destroy");
      destroy.mockRejectedValueOnce(new Error("injected shell owner failure"));
      const logs: string[] = [];
      await expect(
        createShutdownAll(store, (message) => logs.push(message), vi.fn())(),
      ).rejects.toThrow("Daemon cleanup incomplete");
      expect(destroy.mock.calls.map(([id]) => id)).toEqual([shell.id, personal.id, managed.id]);
      expect(shell.taskExecution.accepting).toBe(false);
      expect(await tmux.hasSession("managed")).toBe(false);
      expect(await tmux.hasSession("personal")).toBe(true);
      expect(await tmux.paneExists(origins.get("personal") ?? "")).toBe(true);
      expect(await tmux.hasSession("unrelated")).toBe(true);
      expect(logs.join("\n")).toContain("injected shell owner failure");
      complete = true;
    } finally {
      for (const id of store.ownedSessionIds()) {
        await store.destroy(id);
      }
      await store.sentra.close();
      store.stop();
      for (const name of names) {
        if (await tmux.hasSession(name)) {
          await tmux.killSession(name);
        }
      }
      if (previousTmp === undefined) {
        delete process.env.TMUX_TMPDIR;
      } else {
        process.env.TMUX_TMPDIR = previousTmp;
      }
      if (complete) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
