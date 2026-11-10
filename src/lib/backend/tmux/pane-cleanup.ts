import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";

interface PaneOwnership {
  rootPid?: number;
  root?: ProcessIdentity;
  members: Map<number, ProcessIdentity>;
}
interface PaneCleanupOptions {
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

async function bounded<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("termination deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("termination deadline exceeded")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class PaneCleanup {
  private readonly readIdentity: (pid: number) => Promise<ProcessIdentity | null>;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly descendants: (pid: number) => Promise<number[]>;
  public constructor(
    descendants: (pid: number) => Promise<number[]>,
    options: PaneCleanupOptions = {},
  ) {
    this.descendants = descendants;
    this.readIdentity =
      options.readProcessIdentity ?? createProcessInspection().readProcessIdentity;
    this.kill =
      options.kill ??
      ((pid, signal) => {
        process.kill(pid, signal);
      });
  }
  public async capture(rootPid: Promise<number>): Promise<PaneOwnership> {
    const ownership: PaneOwnership = { members: new Map() };
    try {
      ownership.rootPid = await rootPid;
      ownership.root = (await this.readIdentity(ownership.rootPid)) ?? undefined;
    } catch {
      // Graceful stop remains available when birth inspection is unavailable.
    }
    return ownership;
  }
  private async recordMembers(ownership: PaneOwnership, deadline: number): Promise<void> {
    const { root } = ownership;
    if (!root) {
      return;
    }
    const current = await bounded(async () => this.readIdentity(root.pid), deadline);
    if (!current || !sameProcess(root, current)) {
      return;
    }
    const pids = await bounded(async () => this.descendants(root.pid), deadline);
    for (const pid of pids) {
      if (pid !== root.pid && !ownership.members.has(pid)) {
        // eslint-disable-next-line no-await-in-loop -- record each candidate before signalling
        const member = await bounded(async () => this.readIdentity(pid), deadline);
        if (member && member.sid === root.sid) {
          ownership.members.set(pid, member);
        }
      }
    }
  }
  private async liveMembers(
    ownership: PaneOwnership,
    deadline: number,
  ): Promise<ProcessIdentity[]> {
    const live: ProcessIdentity[] = [];
    for (const member of ownership.members.values()) {
      // eslint-disable-next-line no-await-in-loop -- verify recorded birth and group identity
      const current = await bounded(async () => this.readIdentity(member.pid), deadline);
      if (current && sameProcess(member, current)) {
        live.push(member);
      }
    }
    return live;
  }
  private async running(
    ownership: PaneOwnership,
    isRunning: () => Promise<boolean>,
    deadline: number,
  ): Promise<boolean> {
    const paneRunning = await bounded(isRunning, deadline);
    const members = await this.liveMembers(ownership, deadline);
    return paneRunning || members.length > 0;
  }
  private async force(ownership: PaneOwnership, deadline: number): Promise<void> {
    const members = await this.liveMembers(ownership, deadline);
    if (members.length === 0) {
      throw new Error("termination deadline exceeded: owned process identity unverifiable");
    }
    for (const member of members.toReversed()) {
      // eslint-disable-next-line no-await-in-loop -- revalidate immediately before each signal
      const current = await bounded(async () => this.readIdentity(member.pid), deadline);
      if (Date.now() >= deadline) {
        throw new Error("termination deadline exceeded");
      }
      if (member.pid !== ownership.rootPid && current && sameProcess(member, current)) {
        try {
          this.kill(member.pid, "SIGKILL");
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ESRCH"
            )
          ) {
            throw error;
          }
        }
      }
    }
  }
  public async stop(
    captured: Promise<PaneOwnership>,
    interrupt: () => Promise<void>,
    isRunning: () => Promise<boolean>,
  ): Promise<number> {
    const startedAt = Date.now();
    const graceDeadline = startedAt + 5000;
    const killDeadline = startedAt + 6000;
    const ownership = await bounded(async () => captured, graceDeadline);
    await this.recordMembers(ownership, graceDeadline);
    await bounded(interrupt, graceDeadline);
    while (Date.now() < graceDeadline) {
      if (!(await this.running(ownership, isRunning, graceDeadline))) {
        return startedAt + 7000;
      }
      await this.recordMembers(ownership, graceDeadline);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, graceDeadline - Date.now())),
      );
    }
    if (!(await this.running(ownership, isRunning, killDeadline))) {
      return startedAt + 7000;
    }
    await this.force(ownership, killDeadline);
    while (Date.now() < killDeadline) {
      if (!(await this.running(ownership, isRunning, killDeadline))) {
        return startedAt + 7000;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, killDeadline - Date.now())),
      );
    }
    throw new Error("termination deadline exceeded: owned process survived SIGKILL");
  }
}

export { PaneCleanup, bounded };
export type { PaneOwnership, PaneCleanupOptions };
