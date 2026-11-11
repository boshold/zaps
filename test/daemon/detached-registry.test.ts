import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DetachedRegistry } from "../../src/daemon/detached-registry.js";
import type { DetachedRegistryDeps } from "../../src/daemon/detached-registry.js";
import { createProcessInspection } from "../../src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "../../src/lib/backend/runtime/process-inspection.js";

let tmpDir = "";
let filePath = "";
const leader: ProcessIdentity = {
  pid: 300,
  startTime: "100",
  pgid: 300,
  sid: 300,
  cmdline: "before",
};
const member: ProcessIdentity = { ...leader, pid: 301, startTime: "101" };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-detached-"));
  filePath = path.join(tmpDir, "detached.json");
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJournal() {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
}
function fixture(overrides: Partial<DetachedRegistryDeps> = {}) {
  const live = new Map<number, ProcessIdentity>([[leader.pid, leader]]);
  const kill = vi.fn((pid: number, _signal: NodeJS.Signals) => {
    live.delete(pid);
  });
  const diagnostic = vi.fn();
  const registry = new DetachedRegistry({
    filePath,
    readProcessIdentity: async (pid) => live.get(pid) ?? null,
    getProcessMembers: async () => [...live.values()],
    kill,
    diagnostic,
    termGraceMs: 0,
    killWaitMs: 0,
    probeWaitMs: 20,
    ...overrides,
  });
  return { registry, live, kill, diagnostic };
}

describe("ownership journal", () => {
  it("ignores command changes in the same lifetime", async () => {
    const { registry, live, kill } = fixture();
    await registry.record(300);
    live.set(300, { ...leader, cmdline: "after exec or title change" });
    await registry.reapOrphans();
    expect(kill).toHaveBeenCalledWith(300, "SIGTERM");
    expect(readJournal()).toEqual({});
  });

  it.each([{ startTime: "999" }, { pgid: 999 }, { sid: 999 }])(
    "never signals changed ownership %j",
    async (change) => {
      const { registry, live, kill, diagnostic } = fixture();
      await registry.record(300);
      live.set(300, { ...leader, ...change });
      await registry.reapOrphans();
      expect(kill).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
      expect(readJournal()["300"]).toBeDefined();
    },
  );

  it("normalizes legacy birth evidence using live group/session checks", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ 300: { pid: 300, startTime: "100", cmdline: "old" } }),
    );
    const { registry, kill } = fixture();
    await registry.reapOrphans();
    expect(kill).toHaveBeenCalledWith(300, "SIGTERM");
  });

  it("rejects legacy identity without expected session", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ 300: { pid: 300, startTime: "100", cmdline: "old" } }),
    );
    const { registry, kill } = fixture({
      readProcessIdentity: async () => ({ ...leader, sid: 5 }),
    });
    await registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
    expect(readJournal()["300"]).toBeDefined();
  });

  it("retains members after leader exit and cleans them on restart", async () => {
    const first = fixture();
    first.live.set(301, member);
    await first.registry.record(300);
    first.live.delete(300);
    await first.registry.remove(300);
    expect(readJournal()["300"]).toBeDefined();
    const next = fixture({
      readProcessIdentity: async (pid) => first.live.get(pid) ?? null,
      getProcessMembers: async () => [...first.live.values()],
      kill: (pid) => {
        first.live.delete(pid);
      },
    });
    await next.registry.reapOrphans();
    expect(first.live.size).toBe(0);
    expect(readJournal()).toEqual({});
  });

  it("does not signal unrecorded candidates after all anchors disappear", async () => {
    const { registry, live, kill } = fixture();
    await registry.record(300);
    live.delete(300);
    live.set(301, member);
    await registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
    expect(readJournal()["300"]).toBeDefined();
  });

  it("rechecks discovered birth identity immediately before signalling", async () => {
    let reads = 0;
    const { registry, kill } = fixture({
      readProcessIdentity: async (pid) =>
        pid === 300
          ? leader
          : { ...member, startTime: (reads += 1) > 1 ? "reused" : member.startTime },
      getProcessMembers: async () => [leader, member],
    });
    await registry.record(300);
    await registry.reapOrphans();
    expect(kill.mock.calls.every(([pid]) => pid === 300)).toBe(true);
  });

  it("escalates surviving members when the leader disappears during signalling", async () => {
    const { registry, live, kill, diagnostic } = fixture();
    live.set(member.pid, member);
    await registry.record(leader.pid);
    kill.mockImplementation((pid, signal) => {
      if (pid === leader.pid) {
        live.delete(pid);
        throw Object.assign(new Error("process disappeared"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL") {
        live.delete(pid);
      }
    });
    await registry.reapOrphans();
    expect(kill.mock.calls).toEqual([
      [leader.pid, "SIGTERM"],
      [member.pid, "SIGTERM"],
      [member.pid, "SIGKILL"],
    ]);
    expect(readJournal()).toEqual({});
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("escalates stubborn members and retains unresolved evidence", async () => {
    const kill = vi.fn();
    const { registry, diagnostic } = fixture({ kill });
    await registry.record(300);
    await registry.reapOrphans();
    expect(kill.mock.calls).toEqual([
      [300, "SIGTERM"],
      [300, "SIGKILL"],
    ]);
    expect(readJournal()["300"]).toBeDefined();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("survived SIGKILL"));
  });

  it.each([new Error("inspection unavailable"), new Error("EPERM")])(
    "preserves evidence on failures: %s",
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- parameterized test callback
    async (error) => {
      const { registry, diagnostic } = fixture({
        kill: () => {
          throw error;
        },
      });
      await registry.record(300);
      await registry.reapOrphans();
      expect(readJournal()["300"]).toBeDefined();
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(error.message));
    },
  );

  it("bounds unavailable inspection and retains missing identities", async () => {
    const { registry, kill, diagnostic } = fixture({
      readProcessIdentity: async () =>
        new Promise(() => {
          /* Deliberately stalled probe. */
        }),
    });
    await registry.record(300);
    await registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(readJournal()["300"]).toBeDefined();
  });

  it("serializes record/remove and removes fully exited entries", async () => {
    const { registry, live } = fixture();
    const recorded = registry.record(300);
    await recorded;
    live.clear();
    await registry.remove(300);
    expect(readJournal()).toEqual({});
  });

  it.each([
    "{bad",
    "[]",
    JSON.stringify({
      bad: { pid: -1 },
      300: { pid: 300.5, startTime: "100" },
      301: { pid: 300, startTime: "100" },
    }),
  ])("validates unknown journal data: %s", async (contents) => {
    fs.writeFileSync(filePath, contents);
    const { registry, kill } = fixture();
    await registry.reapOrphans();
    expect(kill).not.toHaveBeenCalled();
    expect(readJournal()).toEqual({});
  });
});

function positiveChildPid(value: number | undefined): number {
  return z.number().int().positive().parse(value);
}

it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "tracks a real shell exec, title change and exited leader",
  async () => {
    const child = spawn(
      "sh",
      [
        "-c",
        String.raw`read line; exec "$NODE" -e 'process.title="journal-title"; process.stdout.write("ready\n"); process.stdin.once("data",()=>{const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(c.pid); process.stdin.once("data",()=>process.exit(0));}); setInterval(()=>{},1000)'`,
      ],
      {
        detached: true,
        env: { ...process.env, NODE: process.execPath },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const inspection = createProcessInspection();
    const diagnostic = vi.fn();
    const kill = vi.fn((target: number, signal: NodeJS.Signals) => {
      process.kill(target, signal);
    });
    const registry = new DetachedRegistry({
      filePath,
      termGraceMs: 50,
      killWaitMs: 50,
      diagnostic,
      kill,
    });
    const pid = positiveChildPid(child.pid);
    try {
      await registry.record(pid);
      const initial = await inspection.readProcessIdentity(pid);
      const ready = once(child.stdout, "data");
      child.stdin.write("exec\n");
      await ready;
      const changed = await inspection.readProcessIdentity(pid);
      expect(changed?.startTime).toBe(initial?.startTime);
      expect(changed?.cmdline).toContain("journal-title");
      const spawned = once(child.stdout, "data");
      child.stdin.write("spawn\n");
      await spawned;
      await registry.record(pid);
      const discovered = initial ? await inspection.getProcessMembers(initial) : [];
      const grandchild = discovered.find((item) => item.pid !== pid);
      const grandchildPid = positiveChildPid(grandchild?.pid);
      const exited = once(child, "exit");
      child.stdin.write("exit\n");
      await exited;
      await registry.remove(pid);
      expect(readJournal()[String(pid)]).toBeDefined();
      await registry.reapOrphans();
      // Some hosts retain orphan zombies; they must remain journaled, never claimed cleaned.
      const members = initial ? await inspection.getProcessMembers(initial) : [];
      expect(members.every((item) => item.pid !== pid)).toBe(true);
      expect(kill).toHaveBeenCalledWith(grandchildPid, "SIGTERM");
      if (readJournal()[String(pid)] !== undefined) {
        const unresolved = z
          .object({ ownedMembers: z.array(z.object({ pid: z.number() })) })
          .parse(readJournal()[String(pid)]);
        expect(unresolved.ownedMembers).toContainEqual(
          expect.objectContaining({ pid: grandchildPid }),
        );
        expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
      } else {
        expect(members.some((item) => item.pid === grandchildPid)).toBe(false);
        expect(readJournal()).toEqual({});
      }
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      child.stdin.destroy();
      child.stdout.destroy();
    }
  },
  5000,
);
