import {
  createProcessInspection,
  sameProcess,
} from "#src/lib/backend/runtime/process-inspection.js";
import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";

interface PaneOwnership {
  rootPid?: number;
  root?: ProcessIdentity;
  members: Map<number, ProcessIdentity>;
  excluded: Map<number, ProcessIdentity>;
}
interface PaneCleanupOptions {
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  getProcessMembers?: (identity: ProcessIdentity) => Promise<ProcessIdentity[]>;
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
  private readonly groupMembers: (identity: ProcessIdentity) => Promise<ProcessIdentity[]>;
  private readonly descendants: (pid: number) => Promise<number[]>;
  public constructor(
    descendants: (pid: number) => Promise<number[]>,
    options: PaneCleanupOptions = {},
  ) {
    this.descendants = descendants;
    const inspection = createProcessInspection();
    this.groupMembers = options.getProcessMembers ?? inspection.getProcessMembers;
    this.readIdentity = options.readProcessIdentity ?? inspection.readProcessIdentity;
    this.kill =
      options.kill ??
      ((pid, signal) => {
        process.kill(pid, signal);
      });
  }
  public async capture(rootPid: Promise<number>): Promise<PaneOwnership> {
    const ownership: PaneOwnership = { members: new Map(), excluded: new Map() };
    try {
      ownership.rootPid = await rootPid;
      ownership.root = (await this.readIdentity(ownership.rootPid)) ?? undefined;
    } catch {
      // Graceful stop remains available when birth inspection is unavailable.
    }
    if (ownership.root) {
      await this.recordMembers(ownership, Date.now() + 1000);
      ownership.excluded = new Map(ownership.members);
      ownership.members.clear();
    }
    return ownership;
  }

  public async candidates(captured: Promise<PaneOwnership>, pids: number[]): Promise<number[]> {
    const ownership = await captured;
    const result: number[] = [];
    for (const pid of pids) {
      const previous = ownership.excluded.get(pid);
      // eslint-disable-next-line no-await-in-loop -- exclude unchanged prelaunch jobs
      const current = previous ? await this.readIdentity(pid) : null;
      if (!previous || !current || !sameProcess(previous, current)) {
        result.push(pid);
      }
    }
    return result;
  }

  private static record(ownership: PaneOwnership, member: ProcessIdentity): void {
    const excluded = ownership.excluded.get(member.pid);
    if (
      member.pid !== ownership.rootPid &&
      !ownership.members.has(member.pid) &&
      (!excluded || !sameProcess(excluded, member))
    ) {
      ownership.members.set(member.pid, member);
    }
  }

  public async register(
    captured: Promise<PaneOwnership>,
    pid: number,
    memberPid?: number,
  ): Promise<void> {
    const deadline = Date.now() + 1000;
    const ownership = await bounded(async () => captured, deadline);
    const { root } = ownership;
    if (!root) {
      throw new Error("Pane process identity unavailable");
    }
    const current = await bounded(async () => this.readIdentity(root.pid), deadline);
    const descendants = await bounded(async () => this.descendants(root.pid), deadline);
    const member = await bounded(async () => this.readIdentity(pid), deadline);
    if (
      !current ||
      !sameProcess(root, current) ||
      !descendants.includes(pid) ||
      !member ||
      member.pgid !== pid ||
      (typeof member.sid === "number" && member.sid !== pid)
    ) {
      throw new Error("Wrapper process ownership unverifiable");
    }
    const recorded = ownership.members.get(pid);
    if (recorded && !sameProcess(recorded, member)) {
      throw new Error("Wrapper process identity changed");
    }
    ownership.members.set(pid, member);
    if (memberPid !== undefined) {
      const anchor = await bounded(async () => this.readIdentity(memberPid), deadline);
      const recordedAnchor = ownership.members.get(memberPid);
      if (
        !anchor ||
        memberPid === pid ||
        !descendants.includes(memberPid) ||
        anchor.pgid !== member.pgid ||
        anchor.sid !== member.sid ||
        (recordedAnchor && !sameProcess(recordedAnchor, anchor))
      ) {
        throw new Error("Wrapper group keeper unverifiable");
      }
      ownership.members.set(memberPid, anchor);
    }
  }

  private async recordMembers(ownership: PaneOwnership, deadline: number): Promise<void> {
    const { root } = ownership;
    if (!root) {
      return;
    }
    const current = await bounded(async () => this.readIdentity(root.pid), deadline);
    const rootLive = current !== null && sameProcess(root, current);
    const groups = new Map<string, ProcessIdentity>();
    if (rootLive && root.pgid === root.pid) {
      groups.set(`${String(root.sid)}:${String(root.pgid)}`, root);
    }
    for (const member of await this.liveMembers(ownership, deadline)) {
      groups.set(`${String(member.sid)}:${String(member.pgid)}`, member);
    }
    for (const identity of groups.values()) {
      // eslint-disable-next-line no-await-in-loop -- expand only verified owned groups
      const candidates = await bounded(async () => this.groupMembers(identity), deadline);
      // eslint-disable-next-line no-await-in-loop -- retain a live birth-verified group anchor
      const anchor = await bounded(async () => this.readIdentity(identity.pid), deadline);
      if (!anchor || !sameProcess(identity, anchor)) {
        for (const candidate of candidates) {
          const recorded =
            ownership.members.get(candidate.pid) ?? ownership.excluded.get(candidate.pid);
          if (!recorded || !sameProcess(recorded, candidate)) {
            throw new Error("Owned process group anchor changed");
          }
        }
        continue;
      }
      for (const member of candidates) {
        PaneCleanup.record(ownership, member);
      }
    }
    if (!rootLive) {
      return;
    }
    const pids = await bounded(async () => this.descendants(root.pid), deadline);
    for (const pid of pids) {
      if (pid !== root.pid && !ownership.members.has(pid)) {
        // eslint-disable-next-line no-await-in-loop -- record each candidate before signalling
        const member = await bounded(async () => this.readIdentity(pid), deadline);
        if (member) {
          PaneCleanup.record(ownership, member);
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
      try {
        if (!(await this.running(ownership, isRunning, graceDeadline))) {
          return startedAt + 7000;
        }
        await this.recordMembers(ownership, graceDeadline);
      } catch (error) {
        if (Date.now() < graceDeadline || ownership.members.size === 0) {
          throw error;
        }
        break;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(1, Math.min(25, graceDeadline - Date.now()))),
      );
    }
    const remaining = await this.liveMembers(ownership, killDeadline);
    if (remaining.length === 0) {
      if (!(await this.running(ownership, isRunning, killDeadline))) {
        return startedAt + 7000;
      }
      throw new Error("termination deadline exceeded: owned process identity unverifiable");
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
