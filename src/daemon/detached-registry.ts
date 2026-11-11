import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";

import { daemonDir } from "./lifecycle.js";

const positivePid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({
  pid: positivePid,
  startTime: z.string().min(1),
  pgid: positivePid,
  sid: z.union([positivePid, z.string().regex(/^[\da-f]+$/i)]),
  cmdline: z.string().optional(),
});
const entrySchema = z.object({
  pid: positivePid,
  startTime: z.string(),
  cmdline: z.string().optional(),
  identity: identitySchema.optional(),
  ownedMembers: z.array(identitySchema).default([]),
});
type DetachedEntry = z.infer<typeof entrySchema>;

export interface DetachedRegistryDeps {
  filePath: string;
  readProcessIdentity: (pid: number) => Promise<ProcessIdentity | null>;
  getProcessMembers: (identity: ProcessIdentity) => Promise<ProcessIdentity[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  diagnostic: (message: string) => void;
  termGraceMs: number;
  killWaitMs: number;
  probeWaitMs: number;
  pollMs: number;
}

export class DetachedRegistry {
  private readonly overrides: Partial<DetachedRegistryDeps>;
  private resolved: DetachedRegistryDeps | null = null;
  private pending: Promise<void> = Promise.resolve();

  public constructor(deps: Partial<DetachedRegistryDeps> = {}) {
    this.overrides = deps;
  }

  private get deps(): DetachedRegistryDeps {
    this.resolved ??= {
      ...createProcessInspection(),
      filePath: this.overrides.filePath ?? path.join(daemonDir(), "detached.json"),
      kill: (pid, signal) => {
        process.kill(pid, signal);
      },
      diagnostic: (message) => {
        process.stderr.write(`${message}\n`);
      },
      termGraceMs: 5000,
      killWaitMs: 1000,
      probeWaitMs: 1000,
      pollMs: 25,
      ...this.overrides,
    };
    return this.resolved;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.pending;
    this.pending = (async () => {
      await previous;
      try {
        await operation();
      } catch (error) {
        this.deps.diagnostic(`Detached cleanup incomplete: ${String(error)}`);
      }
    })();
    return this.pending;
  }

  private async probe<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("process inspection timed out"));
          }, this.deps.probeWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async record(pid: number): Promise<void> {
    return this.enqueue(async () => {
      positivePid.parse(pid);
      const data = this.load();
      const entry: DetachedEntry = { pid, startTime: "", ownedMembers: [] };
      data[String(pid)] = entry;
      try {
        const identity = await this.probe(this.deps.readProcessIdentity(pid));
        if (identity && identity.pid === pid && identity.pgid === pid) {
          entry.identity = identity;
          entry.startTime = identity.startTime;
          entry.cmdline = identity.cmdline;
          entry.ownedMembers = [identity];
          await this.refresh(entry);
        } else {
          this.deps.diagnostic(
            `Detached cleanup incomplete for ${pid}: missing ownership identity`,
          );
        }
      } finally {
        this.save(data);
      }
    });
  }

  public async remove(pid: number): Promise<void> {
    return this.enqueue(async () => {
      const data = this.load();
      const entry = data[String(pid)];
      if (!entry) {
        return;
      }
      try {
        const members = await this.refresh(entry);
        if (members.length === 0) {
          Reflect.deleteProperty(data, String(pid));
        } else {
          this.deps.diagnostic(`Detached cleanup incomplete for ${pid}: owned members remain`);
        }
      } finally {
        this.save(data);
      }
    });
  }

  private async refresh(entry: DetachedEntry): Promise<ProcessIdentity[]> {
    if (!entry.identity) {
      const leader = await this.probe(this.deps.readProcessIdentity(entry.pid));
      if (
        !leader ||
        !entry.startTime ||
        leader.startTime !== entry.startTime ||
        leader.pgid !== entry.pid ||
        (typeof leader.sid === "number" && leader.sid !== entry.pid)
      ) {
        throw new Error(`missing ownership identity for ${entry.pid}`);
      }
      entry.identity = leader;
      entry.ownedMembers = [leader];
    }
    const expected = entry.identity;
    const live: ProcessIdentity[] = [];
    await Promise.all(
      entry.ownedMembers.map(async (member) => {
        const actual = await this.probe(this.deps.readProcessIdentity(member.pid));
        if (actual && sameProcess(member, actual)) {
          live.push(actual);
        }
      }),
    );
    const candidates = await this.probe(this.deps.getProcessMembers(expected));
    if (live.length > 0) {
      // An unchanged recorded member anchors discovery; recheck it after the query.
      const [anchor] = live;
      const current = await this.probe(this.deps.readProcessIdentity(anchor.pid));
      if (!current || !sameProcess(anchor, current)) {
        throw new Error(`lost ownership anchor for ${entry.pid}`);
      }
      for (const member of candidates) {
        if (
          member.pgid === expected.pgid &&
          member.sid === expected.sid &&
          !live.some((item) => item.pid === member.pid)
        ) {
          live.push(member);
        }
      }
      entry.ownedMembers = live;
    } else if (candidates.length > 0) {
      throw new Error(`unverified leftover group for ${entry.pid}`);
    }
    return live;
  }

  private async signal(entry: DetachedEntry, signal: NodeJS.Signals): Promise<void> {
    const members = await this.refresh(entry);
    const results = await Promise.allSettled(
      members.map(async (member) => {
        const actual = await this.probe(this.deps.readProcessIdentity(member.pid));
        if (actual && sameProcess(member, actual)) {
          try {
            this.deps.kill(member.pid, signal);
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "ESRCH"
            ) {
              throw error;
            }
          }
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }

  private async waitForExit(entry: DetachedEntry, duration: number): Promise<boolean> {
    const deadline = Date.now() + duration;
    while (true) {
      const members = await this.refresh(entry);
      if (members.length === 0) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await delay(Math.min(this.deps.pollMs, remaining));
    }
  }

  public async reapOrphans(): Promise<void> {
    return this.enqueue(async () => {
      const data = this.load();
      await Promise.all(
        Object.entries(data).map(async ([key, entry]) => {
          try {
            await this.signal(entry, "SIGTERM");
            if (!(await this.waitForExit(entry, this.deps.termGraceMs))) {
              await this.signal(entry, "SIGKILL");
              if (!(await this.waitForExit(entry, this.deps.killWaitMs))) {
                throw new Error("owned members survived SIGKILL");
              }
            }
            Reflect.deleteProperty(data, key);
          } catch (error) {
            this.deps.diagnostic(`Detached cleanup incomplete for ${entry.pid}: ${String(error)}`);
          }
        }),
      );
      this.save(data);
    });
  }

  private load(): Record<string, DetachedEntry> {
    const result: Record<string, DetachedEntry> = {};
    try {
      const parsed = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(fs.readFileSync(this.deps.filePath, "utf8")));
      for (const [key, value] of Object.entries(parsed)) {
        const entry = entrySchema.safeParse(value);
        if (!entry.success || key !== String(entry.data.pid)) {
          continue;
        }
        const { identity, ownedMembers } = entry.data;
        if (
          identity &&
          (identity.pid !== entry.data.pid ||
            identity.pgid !== entry.data.pid ||
            identity.startTime !== entry.data.startTime ||
            ownedMembers.some(
              (member) => member.pgid !== identity.pgid || member.sid !== identity.sid,
            ))
        ) {
          continue;
        }
        if (!identity && ownedMembers.length > 0) {
          continue;
        }
        result[key] = entry.data;
      }
    } catch {
      /* Missing or invalid journal. */
    }
    return result;
  }

  private save(data: Record<string, DetachedEntry>): void {
    try {
      fs.writeFileSync(this.deps.filePath, JSON.stringify(data), "utf8");
    } catch (error) {
      this.deps.diagnostic(`Detached journal write failed: ${String(error)}`);
    }
  }
}
