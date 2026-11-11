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
  protectedGroups: Map<string, ProcessIdentity[]>;
  ambiguous: Map<number, ProcessIdentity>;
  independent: boolean;
}
interface PaneCleanupOptions {
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  getDescendantTree?: (pid: number, excluded?: readonly number[]) => Promise<number[]>;
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
  private readonly tree: (pid: number, excluded?: readonly number[]) => Promise<number[]>;
  private readonly descendants: (pid: number) => Promise<number[]>;
  public constructor(
    descendants: (pid: number) => Promise<number[]>,
    options: PaneCleanupOptions = {},
  ) {
    this.descendants = descendants;
    const inspection = createProcessInspection();
    this.tree = options.getDescendantTree ?? inspection.getDescendantTree;
    this.groupMembers = options.getProcessMembers ?? inspection.getProcessMembers;
    this.readIdentity = options.readProcessIdentity ?? inspection.readProcessIdentity;
    this.kill =
      options.kill ??
      ((pid, signal) => {
        process.kill(pid, signal);
      });
  }
  public async capture(rootPid: Promise<number>): Promise<PaneOwnership> {
    const ownership: PaneOwnership = {
      members: new Map(),
      excluded: new Map(),
      protectedGroups: new Map(),
      ambiguous: new Map(),
      independent: false,
    };
    try {
      ownership.rootPid = await rootPid;
      ownership.root = (await this.readIdentity(ownership.rootPid)) ?? undefined;
    } catch {
      // Graceful stop remains available when birth inspection is unavailable.
    }
    const { root } = ownership;
    if (root) {
      const deadline = Date.now() + 1000;
      const pids = await bounded(async () => this.descendants(root.pid), deadline);
      const members = await Promise.all(
        pids
          .filter((pid) => pid !== root.pid)
          .map(async (pid) => bounded(async () => this.readIdentity(pid), deadline)),
      );
      const current = await bounded(async () => this.readIdentity(root.pid), deadline);
      if (!current || !sameProcess(root, current)) {
        throw new Error("Pane process identity changed before launch");
      }
      for (const member of members) {
        if (member) {
          PaneCleanup.protect(ownership, member);
        }
      }
    }
    return ownership;
  }

  private static groupKey(identity: ProcessIdentity): string {
    return JSON.stringify([identity.sid, identity.pgid]);
  }

  private static protect(ownership: PaneOwnership, member: ProcessIdentity): void {
    const previous = ownership.excluded.get(member.pid);
    if (previous && !sameProcess(previous, member)) {
      throw new Error("Protected process identity changed");
    }
    ownership.excluded.set(member.pid, member);
    const key = PaneCleanup.groupKey(member);
    const group = ownership.protectedGroups.get(key) ?? [];
    if (!group.some((anchor) => sameProcess(anchor, member))) {
      group.push(member);
    }
    ownership.protectedGroups.set(key, group);
    const owned = ownership.members.get(member.pid);
    if (owned && sameProcess(owned, member)) {
      ownership.members.delete(member.pid);
    }
  }

  private static protected(ownership: PaneOwnership, member: ProcessIdentity): boolean {
    const group = ownership.protectedGroups.get(PaneCleanup.groupKey(member));
    if (!group) {
      return false;
    }
    const known = ownership.excluded.get(member.pid);
    if (known && sameProcess(known, member)) {
      return true;
    }
    if (ownership.root && PaneCleanup.groupKey(member) === PaneCleanup.groupKey(ownership.root)) {
      ownership.ambiguous.set(member.pid, member);
    }
    PaneCleanup.protect(ownership, member);
    return true;
  }

  private static isolated(ownership: PaneOwnership): boolean {
    return ownership.independent;
  }

  private async assertUnambiguous(ownership: PaneOwnership, deadline: number): Promise<void> {
    if (PaneCleanup.isolated(ownership)) {
      return;
    }
    const rootGroup = ownership.root && PaneCleanup.groupKey(ownership.root);
    const shared = [...ownership.excluded.values()].filter(
      (member) => PaneCleanup.groupKey(member) === rootGroup,
    );
    const ambiguous = await this.identities([...ownership.ambiguous.values(), ...shared], deadline);
    if (ambiguous.length > 0) {
      throw new Error(
        `Process ownership ambiguous in protected pane group (root=${String(ownership.rootPid)}; protected=${[...ownership.excluded.values()].map((member) => `${String(member.pid)}/${String(member.pgid)}/${String(member.sid)}`).join(",")})`,
      );
    }
  }

  private async identities(
    members: readonly ProcessIdentity[],
    deadline: number,
  ): Promise<ProcessIdentity[]> {
    const current = await Promise.all(
      members.map(async (member) => {
        const actual = await bounded(async () => this.readIdentity(member.pid), deadline);
        return actual && sameProcess(member, actual) ? member : null;
      }),
    );
    return current.filter((member) => member !== null);
  }

  private async refreshProtected(ownership: PaneOwnership, deadline: number): Promise<void> {
    const anchors = await this.identities([...ownership.excluded.values()], deadline);
    await Promise.all(
      anchors.map(async (anchor) => {
        const pids = await bounded(async () => this.tree(anchor.pid), deadline);
        const candidates = await Promise.all(
          pids.map(async (pid) => bounded(async () => this.readIdentity(pid), deadline)),
        );
        const current = await bounded(async () => this.readIdentity(anchor.pid), deadline);
        if (current && sameProcess(anchor, current)) {
          for (const member of candidates) {
            if (member && member.pid !== ownership.rootPid) {
              PaneCleanup.protect(ownership, member);
            }
          }
        }
      }),
    );
  }

  public async candidates(captured: Promise<PaneOwnership>, pids: number[]): Promise<number[]> {
    const ownership = await captured;
    const deadline = Date.now() + 1000;
    const { root } = ownership;
    if (!root) {
      return pids;
    }
    const before = await bounded(async () => this.readIdentity(root.pid), deadline);
    if (!before || !sameProcess(root, before)) {
      throw new Error("Pane process identity changed");
    }
    await this.refreshProtected(ownership, deadline);
    const [identities, tree] = await Promise.all([
      Promise.all(pids.map(async (pid) => bounded(async () => this.readIdentity(pid), deadline))),
      bounded(async () => this.tree(root.pid, [...ownership.excluded.keys()]), deadline),
    ]);
    const after = await bounded(async () => this.readIdentity(root.pid), deadline);
    if (!after || !sameProcess(root, after)) {
      throw new Error("Pane process identity changed");
    }
    const candidates = pids.filter((_pid, index) => {
      const member = identities[index];
      if (!member || member.pid === ownership.rootPid) {
        return true;
      }
      if (PaneCleanup.protected(ownership, member)) {
        return false;
      }
      PaneCleanup.record(ownership, member, tree.includes(member.pid));
      return !PaneCleanup.protected(ownership, member);
    });
    await this.assertUnambiguous(ownership, deadline);
    return candidates;
  }

  private static record(ownership: PaneOwnership, member: ProcessIdentity, proven = false): void {
    if (member.pid === ownership.rootPid) {
      return;
    }
    if (ownership.root && PaneCleanup.groupKey(member) === PaneCleanup.groupKey(ownership.root)) {
      ownership.ambiguous.set(member.pid, member);
      PaneCleanup.protect(ownership, member);
      return;
    }
    if (ownership.members.has(member.pid) || PaneCleanup.protected(ownership, member)) {
      return;
    }
    const protectedSession = [...ownership.protectedGroups.values()].some((group) =>
      group.some((anchor) => anchor.sid === member.sid),
    );
    if (!proven && protectedSession) {
      throw new Error("Unverifiable orphan process ownership in protected session");
    }
    ownership.members.set(member.pid, member);
    if (proven) {
      ownership.independent = true;
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
    ownership.independent ||= PaneCleanup.groupKey(member) !== PaneCleanup.groupKey(root);
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

  public async registerPaneCommand(
    captured: Promise<PaneOwnership>,
    pid: number,
    confirm: () => Promise<number>,
  ): Promise<void> {
    const deadline = Date.now() + 1000;
    const ownership = await bounded(async () => captured, deadline);
    const { root } = ownership;
    if (!root || pid === root.pid) {
      throw new Error("Raw pane ownership unavailable");
    }
    const before = await bounded(async () => this.readIdentity(root.pid), deadline);
    const initial = await bounded(async () => this.readIdentity(pid), deadline);
    if (
      !initial ||
      initial.pgid !== pid ||
      initial.sid !== root.sid ||
      ownership.protectedGroups.has(PaneCleanup.groupKey(initial))
    ) {
      throw new Error("Raw pane group ownership unverifiable");
    }
    const acknowledged = await bounded(confirm, deadline);
    const tree = await bounded(
      async () => this.tree(root.pid, [...ownership.excluded.keys()]),
      deadline,
    );
    const member = await bounded(async () => this.readIdentity(pid), deadline);
    const after = await bounded(async () => this.readIdentity(root.pid), deadline);
    if (
      acknowledged !== pid ||
      !before ||
      !after ||
      !sameProcess(root, before) ||
      !sameProcess(root, after) ||
      !tree.includes(pid) ||
      !member ||
      !sameProcess(initial, member)
    ) {
      throw new Error("Raw pane group ownership unverifiable");
    }
    ownership.members.set(pid, member);
    ownership.independent = true;
  }

  public async workload(captured: Promise<PaneOwnership>, holder: number): Promise<boolean> {
    const deadline = Date.now() + 1000;
    const ownership = await bounded(async () => captured, deadline);
    const members = [...ownership.members.values()];
    const anchor = ownership.members.get(holder);
    const live = await this.identities(members, deadline);
    if (anchor && live.some((member) => member.pid === holder)) {
      await this.recordGroup(
        ownership,
        live.filter((member) => PaneCleanup.groupKey(member) === PaneCleanup.groupKey(anchor)),
        deadline,
      );
    }
    const remaining = await this.liveMembers(ownership, deadline);
    return remaining.some((member) => member.pid !== holder);
  }

  private async recordGroup(
    ownership: PaneOwnership,
    anchors: ProcessIdentity[],
    deadline: number,
  ): Promise<void> {
    const [identity] = anchors;
    if (!identity) {
      return;
    }
    const candidates = await bounded(async () => this.groupMembers(identity), deadline);
    const surviving = await this.identities(anchors, deadline);
    if (surviving.length === 0) {
      for (const candidate of candidates) {
        const recorded =
          ownership.members.get(candidate.pid) ?? ownership.excluded.get(candidate.pid);
        if (!recorded || !sameProcess(recorded, candidate)) {
          throw new Error("Owned process group anchor changed");
        }
      }
      return;
    }
    for (const member of candidates) {
      if (PaneCleanup.groupKey(member) === PaneCleanup.groupKey(identity)) {
        PaneCleanup.record(ownership, member, true);
      }
    }
  }

  private async recordOwned(ownership: PaneOwnership, deadline: number): Promise<void> {
    const members = await this.liveMembers(ownership, deadline);
    const groups = new Map<string, ProcessIdentity[]>();
    for (const member of members) {
      const key = PaneCleanup.groupKey(member);
      const group = groups.get(key) ?? [];
      group.push(member);
      groups.set(key, group);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => this.recordGroup(ownership, group, deadline)),
    );
  }

  private async recordMembers(ownership: PaneOwnership, deadline: number): Promise<void> {
    const { root } = ownership;
    if (!root) {
      return;
    }
    await this.refreshProtected(ownership, deadline);
    const [current, members] = await Promise.all([
      bounded(async () => this.readIdentity(root.pid), deadline),
      this.liveMembers(ownership, deadline),
    ]);
    const rootLive = current !== null && sameProcess(root, current);
    const groups = new Map<string, ProcessIdentity[]>();
    const anchors = rootLive && root.pgid === root.pid ? [root, ...members] : members;
    for (const member of anchors) {
      const key = PaneCleanup.groupKey(member);
      const group = groups.get(key) ?? [];
      group.push(member);
      groups.set(key, group);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => this.recordGroup(ownership, group, deadline)),
    );
    if (!rootLive) {
      await this.assertUnambiguous(ownership, deadline);
      return;
    }
    const [pids, tree] = await Promise.all([
      bounded(async () => this.descendants(root.pid), deadline),
      bounded(async () => this.tree(root.pid, [...ownership.excluded.keys()]), deadline),
    ]);
    const candidates = await Promise.all(
      pids
        .filter((pid) => pid !== root.pid && !ownership.members.has(pid))
        .map(async (pid) => bounded(async () => this.readIdentity(pid), deadline)),
    );
    const verifiedRoot = await bounded(async () => this.readIdentity(root.pid), deadline);
    if (verifiedRoot && sameProcess(root, verifiedRoot)) {
      for (const member of candidates) {
        if (member) {
          PaneCleanup.record(ownership, member, tree.includes(member.pid));
        }
      }
    }
    await this.assertUnambiguous(ownership, deadline);
  }

  private async liveMembers(
    ownership: PaneOwnership,
    deadline: number,
  ): Promise<ProcessIdentity[]> {
    return this.identities([...ownership.members.values()], deadline);
  }
  private async running(
    ownership: PaneOwnership,
    isRunning: () => Promise<boolean>,
    deadline: number,
  ): Promise<boolean> {
    const members = await this.liveMembers(ownership, deadline);
    return members.length > 0 || bounded(isRunning, deadline);
  }
  private async signal(
    ownership: PaneOwnership,
    members: ProcessIdentity[],
    signal: NodeJS.Signals,
    deadline: number,
  ): Promise<void> {
    for (const member of members.toReversed()) {
      // eslint-disable-next-line no-await-in-loop -- birth check immediately precedes each signal
      const current = await bounded(async () => this.readIdentity(member.pid), deadline);
      if (Date.now() >= deadline) {
        throw new Error("termination deadline exceeded");
      }
      if (
        member.pid !== ownership.rootPid &&
        current &&
        sameProcess(member, current) &&
        !PaneCleanup.protected(ownership, member)
      ) {
        try {
          this.kill(member.pid, signal);
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
    release?: () => void,
  ): Promise<number> {
    const startedAt = Date.now();
    const graceDeadline = startedAt + 5000;
    const killDeadline = startedAt + 6000;
    const ownership = await bounded(async () => captured, graceDeadline);
    await this.recordMembers(ownership, graceDeadline);
    release?.();
    const { root } = ownership;
    const current = root
      ? await bounded(async () => this.readIdentity(root.pid), graceDeadline)
      : undefined;
    const rootChanged = root !== undefined && (!current || !sameProcess(root, current));
    if (rootChanged && !ownership.independent) {
      throw new Error("Pane process identity changed");
    }
    await (rootChanged || PaneCleanup.isolated(ownership)
      ? this.signal(
          ownership,
          await this.liveMembers(ownership, graceDeadline),
          "SIGINT",
          graceDeadline,
        )
      : bounded(interrupt, graceDeadline));
    while (Date.now() < graceDeadline) {
      try {
        if (!(await this.running(ownership, isRunning, graceDeadline))) {
          return startedAt + 7000;
        }
        await this.recordOwned(ownership, graceDeadline);
      } catch (error) {
        if (Date.now() < graceDeadline) {
          throw error;
        }
        if (ownership.members.size === 0) {
          throw new Error("termination deadline exceeded: no verified owned members", {
            cause: error,
          });
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
    await this.signal(ownership, remaining, "SIGKILL", killDeadline);
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
