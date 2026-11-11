import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadConfig } from "#src/config/loader.js";
import { socketPath as daemonSocketPath } from "#src/daemon/lifecycle.js";
import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import { runWithEnvironment } from "#src/lib/request-context.js";

import { createShellTestEnvironment, waitForCondition } from "./helpers.js";

const command = { file: process.execPath, args: [] };

const socketProgram = `
const net = require('node:net');
const server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (!buffer.includes('\\n')) return;
    const request = JSON.parse(buffer.trim());
    const result = request.method === 'invalid' ? 42 : { method: request.method, env: request.context.env };
    socket.end(JSON.stringify({ id: request.id, result }) + '\\n');
  });
});
server.listen(process.env.ZAPS_SOCKET_PATH, () => console.log('listening'));
`;

async function withFixture(
  action: (fixture: ReturnType<typeof createShellTestEnvironment>) => Promise<void>,
) {
  const fixture = createShellTestEnvironment({ command });
  try {
    await action(fixture);
  } finally {
    await fixture.cleanup();
    fixture.assertNoTmux();
  }
}

async function createToolProbe(fixture: ReturnType<typeof createShellTestEnvironment>) {
  return fixture.run([
    "-e",
    `const { spawnSync } = require('node:child_process'); const result = spawnSync('sh', ['-c', 'command -v node && command -v ps && (command -v ss || command -v lsof)'], { stdio: 'inherit' }); process.exitCode = result.status ?? 1`,
  ]);
}

describe("shell integration harness", () => {
  it("isolates private paths and strips inherited tmux/config environment", async () => {
    await runWithEnvironment(
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMUX: "unrelated",
        ZAPS_TMUX_SOCKET: "ambient",
        ZAPS_SOCKET_PATH: "/unrelated",
        ZAPS_ENVIRONMENT_SNAPSHOT: "/unrelated",
      },
      async () => {
        await withFixture(async (first) => {
          await withFixture(async (second) => {
            expect(first.rootDir).not.toBe(second.rootDir);
            expect(first.socketPath).not.toBe(second.socketPath);
            expect(first.env.TMUX).toBeUndefined();
            expect(first.env.ZAPS_TMUX_SOCKET).toBeUndefined();
            expect(first.env.ZAPS_ENVIRONMENT_SNAPSHOT).toBeUndefined();
            expect(first.env.HOME).toBe(first.homeDir);
            expect(runWithEnvironment(first.env, daemonSocketPath)).toBe(first.socketPath);
            expect(fs.statSync(first.runtimeDir).mode % 0o1000).toBe(0o700);
            expect(path.dirname(first.configPath)).toBe(first.projectDir);
            const config = await loadConfig(first.configPath, first.projectDir);
            expect(config.project.services.worker.raw).toBeFalsy();
            expect(config.project.services.worker.start).toContain("console.log('ready')");
          });
        });
      },
    );
  });

  it("uses explicit artifact and literal argv, collects exit/output, retains system tools", async () => {
    const fixture = createShellTestEnvironment({
      command: {
        file: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify(process.argv.slice(1))); console.error('stderr'); process.exitCode = 7`,
          "--",
        ],
      },
    });
    try {
      const args = ["spaces stay", "$(echo should-not-run)", "--flag"];
      const result = await fixture.run(args, { TMUX: "unrelated", TMUX_PANE: "%123" });
      expect(result).toEqual({
        code: 7,
        signal: null,
        stdout: `${JSON.stringify(args)}\n`,
        stderr: "stderr\n",
      });
      expect(fixture.env.PATH.split(path.delimiter)[0]).toBe(path.dirname(fixture.sentinelPath));
    } finally {
      await fixture.cleanup();
      fixture.assertNoTmux();
    }
  });

  it("retains required shell and process inspection tools", async () => {
    await withFixture(async (fixture) => {
      const tools = await createToolProbe(fixture);
      expect(tools.code).toBe(0);
    });
  });

  it("fails fast for missing or implicit artifacts", () => {
    expect(() => createShellTestEnvironment({ command: { file: "node", args: [] } })).toThrow(
      "absolute",
    );
    expect(() =>
      createShellTestEnvironment({ command: { file: "/missing-shell-test-artifact", args: [] } }),
    ).toThrow();
    expect(() =>
      createShellTestEnvironment({
        command: { file: process.execPath, args: ["/missing-shell-test-artifact.mjs"] },
      }),
    ).toThrow();
  });

  it("polls a private socket and validates IPC result at the production boundary", async () => {
    await withFixture(async (fixture) => {
      fixture.spawn(["-e", socketProgram]);
      await fixture.waitForSocket();
      const response = await fixture.request(
        "fixture.ping",
        z.object({ method: z.string(), env: z.record(z.string(), z.string()) }),
      );
      expect(response.method).toBe("fixture.ping");
      expect(response.env.ZAPS_SOCKET_PATH).toBe(fixture.socketPath);
      await expect(fixture.request("invalid", z.object({ method: z.string() }))).rejects.toThrow();
    });
  });

  it("records every sentinel invocation, fails, and preserves evidence after cleanup", async () => {
    const fixture = createShellTestEnvironment({ command });
    try {
      const result = await fixture.run([
        "-e",
        `const { spawnSync } = require('node:child_process'); const a = spawnSync('tmux', ['-V']); const b = spawnSync('tmux', ['list-sessions']); console.log(a.status, b.status)`,
      ]);
      expect(result.stdout).toBe("97 97\n");
      expect(fixture.readTmuxCalls()).toBe("-V\nlist-sessions\n");
      expect(() => fixture.assertNoTmux()).toThrow("Unexpected tmux");
    } finally {
      await fixture.cleanup();
    }
    expect(() => fixture.assertNoTmux()).toThrow("Unexpected tmux");
  });

  it("cleans only owned running processes/socket and is idempotent", async () => {
    const fixture = createShellTestEnvironment({ command });
    const unrelated = createShellTestEnvironment({ command });
    try {
      const owned = fixture.spawn(["-e", socketProgram]);
      const other = unrelated.spawn(["-e", socketProgram]);
      await Promise.all([fixture.waitForSocket(), unrelated.waitForSocket()]);
      await Promise.all([fixture.cleanup(), fixture.cleanup()]);
      const result = await owned.result;
      expect(result.signal).toBe("SIGTERM");
      expect(fs.existsSync(fixture.rootDir)).toBe(false);
      expect(other.child.exitCode).toBeNull();
      expect(other.child.signalCode).toBeNull();
      expect(fs.statSync(unrelated.socketPath).isSocket()).toBe(true);
      await expect(unrelated.request("ping", z.object({ method: z.string() }))).resolves.toEqual({
        method: "ping",
      });
      expect(() => fixture.spawn()).toThrow("cleaned up");
      await fixture.cleanup();
    } finally {
      await Promise.all([fixture.cleanup(), unrelated.cleanup()]);
      fixture.assertNoTmux();
      unrelated.assertNoTmux();
    }
  });

  it("escalates a resistant owned process and removes its runtime", async () => {
    await withFixture(async (fixture) => {
      const running = fixture.spawn([
        "-e",
        `process.on('SIGTERM', () => {}); console.log('resistant'); setInterval(() => {}, 1000)`,
      ]);
      await waitForCondition(() => running.stdout.includes("resistant"));
      await fixture.cleanup();
      const result = await running.result;
      expect(result.signal).toBe("SIGKILL");
      expect(fs.existsSync(fixture.runtimeDir)).toBe(false);
    });
  });

  it.each([false, true])(
    "cleans verified descendants after launcher exit (resistant=%s)",
    async (resistant) => {
      await withFixture(async (fixture) => {
        const childProgram = `if (${resistant}) process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)`;
        const launcher = fixture.spawn([
          "-e",
          `
        const { fork } = require('node:child_process');
        const child = fork('-e', [${JSON.stringify(childProgram)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('message', () => { console.log(child.pid); process.stdin.once('data', () => { child.disconnect(); process.exit(0); }); });
      `,
        ]);
        await waitForCondition(() => launcher.stdout.trim() !== "");
        expect(launcher.child.exitCode).toBeNull();
        const pid = z.coerce.number().int().positive().parse(launcher.stdout.trim());
        const inspection = createProcessInspection();
        const before = await inspection.readProcessIdentity(pid);
        expect(before).not.toBeNull();
        await launcher.refreshOwnership();
        expect(launcher.members.get(pid)).toEqual(before);
        launcher.child.stdin.end("release\n");
        const launcherResult = await launcher.result;
        expect(launcherResult.code).toBe(0);
        await fixture.cleanup();
        const after = await inspection.readProcessIdentity(pid);
        if (after && before && sameProcess(before, after)) {
          const { stdout } = await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)]);
          expect(stdout.trim().startsWith("Z")).toBe(true);
        }
        expect(fs.existsSync(fixture.rootDir)).toBe(false);
      });
    },
  );

  it("records sentinel calls under an apostrophe-containing TMPDIR", async () => {
    // The macOS TMPDIR is long enough to trigger the harness's short /tmp socket fallback.
    const parent = fs.mkdtempSync(path.join("/tmp", "zaps-shell-quoted-'"));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = parent;
    const fixture = createShellTestEnvironment({ command });
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    try {
      expect(fixture.sentinelLog).toContain("'");
      const result = await fixture.run([
        "-e",
        `const result = require('node:child_process').spawnSync('tmux', ['quoted path']); console.log(result.status)`,
      ]);
      expect(result.stdout).toBe("97\n");
      expect(fixture.readTmuxCalls()).toBe("quoted path\n");
      expect(() => fixture.assertNoTmux()).toThrow("Unexpected tmux");
    } finally {
      await fixture.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
    expect(() => fixture.assertNoTmux()).toThrow("Unexpected tmux");
  });

  it("cleans rapid successful native commands without a captured identity", async () => {
    const truePath = z.string().parse(
      (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((directory) => path.resolve(directory, "true"))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()),
    );
    const fixture = createShellTestEnvironment({ command: { file: truePath, args: [] } });
    try {
      const results = await Promise.all(Array.from({ length: 10 }, async () => fixture.run()));
      expect(results.every((result) => result.code === 0)).toBe(true);
      await Promise.all([fixture.cleanup(), fixture.cleanup()]);
      expect(fs.existsSync(fixture.rootDir)).toBe(false);
    } finally {
      await fixture.cleanup();
      fixture.assertNoTmux();
    }
  });

  it("surfaces one ownership failure after cleaning independent resistant processes", async () => {
    const fixture = createShellTestEnvironment({ command });
    const finished = fixture.spawn(["-e", "process.exit(0)"]);
    const running = fixture.spawn([
      "-e",
      "process.on('SIGTERM', () => {}); console.log('resistant'); setInterval(() => {}, 1000)",
    ]);
    const inspection = createProcessInspection();
    await waitForCondition(() => running.stdout.includes("resistant"));
    await finished.result;
    const pid = z.number().int().positive().parse(running.child.pid);
    const before = await inspection.readProcessIdentity(pid);
    const probe = vi
      .spyOn(finished, "refreshOwnership")
      .mockRejectedValue(new Error("fixture identity probe failed"));
    try {
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup incomplete");
      const result = await running.result;
      expect(result.signal).toBe("SIGKILL");
      expect(fs.readFileSync(path.join(fixture.rootDir, "cleanup-error.txt"), "utf8")).toContain(
        "fixture identity probe failed",
      );
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup incomplete");
    } finally {
      probe.mockRestore();
      const current = await inspection.readProcessIdentity(pid);
      if (current && before && sameProcess(before, current)) {
        process.kill(pid, "SIGKILL");
      }
      await running.result;
      fs.rmSync(fixture.rootDir, { recursive: true, force: true });
      fixture.assertNoTmux();
    }
  });

  it("retains diagnostics without signalling unverified surviving descendants", async () => {
    const fixture = createShellTestEnvironment({ command });
    const launcher = fixture.spawn([
      "-e",
      `
      const { fork } = require('node:child_process');
      const child = fork('-e', ["process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => { console.log(child.pid); child.disconnect(); process.exit(0); });
    `,
    ]);
    await launcher.result;
    await launcher.stopTracking();
    const pid = z.coerce.number().int().positive().parse(launcher.stdout.trim());
    const inspection = createProcessInspection();
    const before = await inspection.readProcessIdentity(pid);
    launcher.members.clear();
    try {
      await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup incomplete");
      expect(fs.readFileSync(path.join(fixture.rootDir, "cleanup-error.txt"), "utf8")).toContain(
        "Unverified",
      );
      const after = await inspection.readProcessIdentity(pid);
      expect(before && after && sameProcess(before, after)).toBe(true);
      const { stdout } = await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)]);
      expect(stdout.trim().startsWith("Z")).toBe(false);
    } finally {
      const actual = await inspection.readProcessIdentity(pid);
      if (actual && before && sameProcess(before, actual)) {
        process.kill(pid, "SIGKILL");
      }
      await waitForCondition(async () => {
        const current = await inspection.readProcessIdentity(pid);
        if (!current || !before || !sameProcess(before, current)) {
          return true;
        }
        const { stdout } = await promisify(execFile)("ps", [
          "-o",
          "stat=",
          "-p",
          String(pid),
        ]).catch(() => ({ stdout: "Z" }));
        return stdout.trim().startsWith("Z");
      });
      fs.rmSync(fixture.rootDir, { recursive: true, force: true });
      fixture.assertNoTmux();
    }
  });

  it("rejects ownership path overrides", async () => {
    await withFixture(async (fixture) => {
      expect(() => fixture.spawn([], { ZAPS_SOCKET_PATH: "/unrelated.sock" })).toThrow(
        "owned fixture",
      );
    });
  });

  it("bounds condition polling", async () => {
    await expect(waitForCondition(() => false, 30)).rejects.toThrow("timed out");
  });
});
