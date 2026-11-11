import { afterEach, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { PaneCleanup } from "#src/lib/backend/tmux/pane-cleanup.js";

const root: ProcessIdentity = { pid: 10, pgid: 10, sid: 10, startTime: "root" };
const personal: ProcessIdentity = { pid: 11, pgid: 11, sid: 10, startTime: "personal" };
const owned: ProcessIdentity = { pid: 20, pgid: 20, sid: 20, startTime: "owned" };

function fixture(baseline: ProcessIdentity[] = [root, personal]) {
  const identities = new Map(baseline.map((member) => [member.pid, member]));
  const parents = new Map(
    baseline.map((member) => [member.pid, member.pid === root.pid ? 1 : root.pid]),
  );
  const getDescendantTree = async (pid: number, excluded: readonly number[] = []) => {
    const result = new Set<number>(identities.has(pid) ? [pid] : []);
    const queue = [pid];
    for (const parent of queue) {
      for (const member of identities.values()) {
        if (
          parents.get(member.pid) === parent &&
          !excluded.includes(member.pid) &&
          !result.has(member.pid)
        ) {
          result.add(member.pid);
          queue.push(member.pid);
        }
      }
    }
    return [...result];
  };
  const descendants = async (pid: number) => {
    const result = new Set<number>();
    if (identities.has(pid)) {
      result.add(pid);
    }
    for (const member of identities.values()) {
      if (
        member.sid === pid ||
        (identities.get(pid)?.pgid === pid &&
          member.pgid === pid &&
          member.sid === identities.get(pid)?.sid)
      ) {
        result.add(member.pid);
      }
    }
    const queue = [pid];
    for (const parent of queue) {
      for (const member of identities.values()) {
        if (parents.get(member.pid) === parent && !result.has(member.pid)) {
          result.add(member.pid);
          queue.push(member.pid);
        }
      }
    }
    return [...result];
  };
  const getProcessMembers = vi.fn(async (identity: ProcessIdentity) =>
    [...identities.values()].filter(
      (member) => member.pgid === identity.pgid && member.sid === identity.sid,
    ),
  );
  const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
    if (signal === "SIGKILL") {
      identities.delete(pid);
    }
  });
  const readIdentity = vi.fn(async (pid: number) => identities.get(pid) ?? null);
  const cleanup = new PaneCleanup(descendants, {
    readProcessIdentity: readIdentity,
    getDescendantTree,
    getProcessMembers,
    kill,
  });
  const add = (member: ProcessIdentity, parent = root.pid) => {
    identities.set(member.pid, member);
    parents.set(member.pid, parent);
  };
  return {
    cleanup,
    identities,
    parents,
    descendants,
    getProcessMembers,
    getDescendantTree,
    readIdentity,
    kill,
    add,
  };
}

afterEach(() => vi.useRealTimers());

it.each([false, true])("protects future personal workers after reparent=%s", async (reparent) => {
  vi.useFakeTimers();
  const f = fixture();
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add(owned);
  const worker = { ...personal, pid: 12, startTime: "worker" };
  f.add(worker, personal.pid);
  if (reparent) {
    f.identities.delete(personal.pid);
    f.parents.set(worker.pid, 1);
  }
  const stopping = f.cleanup.stop(
    captured,
    async () => {
      /* Interrupt acknowledged. */
    },
    async () => {
      const pids = await f.cleanup.candidates(captured, await f.descendants(root.pid));
      return pids.some((pid) => pid !== root.pid);
    },
  );
  await vi.advanceTimersByTimeAsync(5100);
  await stopping;
  expect(f.kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
    [owned.pid, "SIGKILL"],
  ]);
  expect(f.identities.get(worker.pid)).toEqual(worker);
});

it("protects witnessed descendants that change their process group", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  const worker = { ...personal, pid: 12, pgid: 12, startTime: "worker" };
  f.add(worker, personal.pid);
  await f.cleanup.candidates(captured, await f.descendants(root.pid));
  f.identities.delete(personal.pid);
  f.parents.set(worker.pid, 1);
  f.add(owned);
  const stopping = f.cleanup.stop(
    captured,
    async () => {
      /* Interrupt acknowledged. */
    },
    async () => false,
  );
  await vi.advanceTimersByTimeAsync(5100);
  await stopping;
  expect(f.kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
    [owned.pid, "SIGKILL"],
  ]);
  expect(f.identities.get(worker.pid)).toEqual(worker);
});

it("does not signal a reused protected group leader", async () => {
  const f = fixture();
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add({ ...personal, startTime: "reused" });
  f.add(owned);
  await expect(f.cleanup.stop(captured, vi.fn(), async () => true)).rejects.toThrow(
    "Protected process identity changed",
  );
  expect(f.kill).not.toHaveBeenCalled();
});

it("refuses protected pane-group ambiguity without independent ownership", async () => {
  const f = fixture([root, { ...personal, pgid: root.pgid }]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add({ ...personal, pid: 12, pgid: root.pgid, startTime: "ambiguous" }, 1);
  const interrupt = vi.fn();
  await expect(f.cleanup.stop(captured, interrupt, async () => true)).rejects.toThrow("ambiguous");
  expect(f.kill).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
});

it("signals only verified independent ownership when protected jobs share the pane group", async () => {
  const f = fixture([root, { ...personal, pgid: root.pgid }]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add(owned);
  await f.cleanup.register(captured, owned.pid);
  f.add({ ...personal, pid: 12, pgid: root.pgid, startTime: "ambiguous" }, 1);
  f.kill.mockImplementation((pid) => {
    f.identities.delete(pid);
  });
  const interrupt = vi.fn();
  await f.cleanup.stop(captured, interrupt, async () => false);
  expect(interrupt).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledExactlyOnceWith(owned.pid, "SIGINT");
  expect(f.identities.has(personal.pid)).toBe(true);
  expect(f.identities.has(12)).toBe(true);
});

it.each([20, 21])(
  "retains another verified group anchor when member %s exits during enumeration",
  async (exiting) => {
    vi.useFakeTimers();
    const f = fixture([root]);
    const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
    const keeper = { ...owned, pid: 21, startTime: "keeper" };
    const worker = { ...owned, pid: 22, startTime: "worker" };
    f.add(owned);
    f.add(keeper, owned.pid);
    await f.cleanup.register(captured, owned.pid, keeper.pid);
    let raced = false;
    f.getProcessMembers.mockImplementation(async (identity) => {
      if (identity.pgid === owned.pgid && !raced) {
        raced = true;
        f.identities.delete(exiting);
        f.add(worker, owned.pid);
      }
      return [...f.identities.values()].filter(
        (member) => member.pgid === identity.pgid && member.sid === identity.sid,
      );
    });
    const stopping = f.cleanup.stop(
      captured,
      async () => {
        /* Interrupt acknowledged. */
      },
      async () => false,
    );
    await vi.advanceTimersByTimeAsync(5100);
    await stopping;
    expect(f.kill).toHaveBeenCalledWith(exiting === owned.pid ? keeper.pid : owned.pid, "SIGKILL");
    expect(f.kill).toHaveBeenCalledWith(worker.pid, "SIGKILL");
    expect(f.kill).not.toHaveBeenCalledWith(exiting, "SIGKILL");
  },
);

it.each([12])(
  "rejects an unobserved personal orphan in group %s without signalling",
  async (pgid) => {
    const f = fixture();
    const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
    f.add(owned);
    await f.cleanup.register(captured, owned.pid);
    const worker = { ...personal, pid: 12, pgid, startTime: "orphan" };
    f.add(worker, 1);
    f.identities.delete(personal.pid);
    f.kill.mockImplementation((pid) => {
      f.identities.delete(pid);
    });
    const interrupt = vi.fn();
    await expect(f.cleanup.stop(captured, interrupt, async () => true)).rejects.toThrow(
      /Unverifiable orphan|ambiguous/u,
    );
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  },
);

it("cleans a raw foreground group proven outside the protected job subtree", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  const raw = { ...owned, sid: root.sid };
  f.add(raw);
  const stopping = f.cleanup.stop(
    captured,
    async () => {
      /* Interrupt acknowledged. */
    },
    async () => false,
  );
  await vi.advanceTimersByTimeAsync(5100);
  await stopping;
  expect(f.kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
    [raw.pid, "SIGKILL"],
  ]);
  expect(f.identities.get(personal.pid)).toEqual(personal);
});

it("does not adopt descendants of a reused pane root", async () => {
  vi.useFakeTimers();
  const f = fixture([root]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add(owned);
  await f.cleanup.register(captured, owned.pid);
  f.add({ ...root, startTime: "reused" }, 1);
  const unrelated = { ...personal, pid: 30, pgid: 30, startTime: "unrelated" };
  f.add(unrelated);
  f.kill.mockImplementation((pid, signal) => {
    if (signal === "SIGKILL") {
      f.identities.delete(pid);
    }
  });
  const interrupt = vi.fn();
  const stopping = f.cleanup.stop(captured, interrupt, async () => false);
  await vi.advanceTimersByTimeAsync(5100);
  await stopping;
  expect(interrupt).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledWith(owned.pid, "SIGINT");
  expect(f.kill).toHaveBeenCalledWith(owned.pid, "SIGKILL");
  expect(f.kill.mock.calls.every(([pid]) => pid === owned.pid)).toBe(true);
  expect(f.identities.get(unrelated.pid)).toEqual(unrelated);
});

it("rechecks each PID immediately before its force signal", async () => {
  vi.useFakeTimers();
  const f = fixture([root]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  const second = { ...owned, pid: 21, startTime: "second" };
  f.add(owned);
  f.add(second, owned.pid);
  await f.cleanup.register(captured, owned.pid, second.pid);
  const started = Date.now();
  let forceReads = 0;
  f.readIdentity.mockImplementation(async (pid) => {
    if (pid === second.pid && Date.now() >= started + 5000) {
      forceReads += 1;
      if (forceReads === 2) {
        f.identities.set(owned.pid, { ...owned, startTime: "reused" });
      }
    }
    return f.identities.get(pid) ?? null;
  });
  const stopping = f.cleanup.stop(
    captured,
    async () => {
      /* Interrupt acknowledged. */
    },
    async () => false,
  );
  await vi.advanceTimersByTimeAsync(5100);
  await stopping;
  expect(f.kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([
    [second.pid, "SIGKILL"],
  ]);
  expect(f.identities.get(owned.pid)?.startTime).toBe("reused");
});

it.each(["before", "during"])(
  "rejects reused pane root %s candidate ancestry reads",
  async (when) => {
    const f = fixture([root]);
    const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
    const unrelated = { ...owned, startTime: "unrelated" };
    f.add(unrelated);
    let reads = 0;
    f.readIdentity.mockImplementation(async (pid) => {
      if (pid === root.pid) {
        reads += 1;
        if (reads === (when === "before" ? 1 : 2)) {
          f.identities.set(root.pid, { ...root, startTime: "reused" });
        }
      }
      return f.identities.get(pid) ?? null;
    });
    await expect(f.cleanup.candidates(captured, [root.pid, unrelated.pid])).rejects.toThrow(
      "Pane process identity changed",
    );
    const ownership = await captured;
    expect(ownership.members.has(unrelated.pid)).toBe(false);
    expect(f.kill).not.toHaveBeenCalled();
  },
);

it("protects pane helpers discovered before a separate owner is classified", async () => {
  const f = fixture([root]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  const helper = { ...personal, pgid: root.pgid };
  f.add(helper);
  f.add(owned);
  f.kill.mockImplementation((pid) => {
    f.identities.delete(pid);
  });
  const interrupt = vi.fn();
  await f.cleanup.stop(captured, interrupt, async () => false);
  expect(interrupt).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledExactlyOnceWith(owned.pid, "SIGINT");
  expect(f.identities.get(helper.pid)).toEqual(helper);
});

it("never sends pane input after releasing an independent holder", async () => {
  const f = fixture([root]);
  const captured = Promise.resolve(await f.cleanup.capture(Promise.resolve(root.pid)));
  f.add(owned);
  await f.cleanup.register(captured, owned.pid);
  f.kill.mockImplementation((pid) => {
    f.identities.delete(pid);
  });
  const helper = { ...personal, pgid: root.pgid };
  const interrupt = vi.fn();
  await f.cleanup.stop(
    captured,
    interrupt,
    async () => false,
    () => {
      f.add(helper);
    },
  );
  expect(interrupt).not.toHaveBeenCalled();
  expect(f.kill).toHaveBeenCalledExactlyOnceWith(owned.pid, "SIGINT");
  expect(f.identities.get(helper.pid)).toEqual(helper);
});
