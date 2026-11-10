import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessIdentity } from "#src/lib/backend/runtime/process-inspection.js";
import { PaneCleanup } from "#src/lib/backend/tmux/pane-cleanup.js";

const root: ProcessIdentity = { pid: 123, pgid: 123, sid: 90, startTime: "root" };
const child: ProcessIdentity = { pid: 124, pgid: 124, sid: 124, startTime: "child" };

afterEach(() => vi.useRealTimers());

describe("pane cleanup ownership regressions", () => {
  it("escalates a wrapper-created session after a grace probe expires", async () => {
    vi.useFakeTimers();
    const identities = new Map([[root.pid, root]]);
    const kill = vi.fn((pid: number) => {
      identities.delete(pid);
    });
    const cleanup = new PaneCleanup(async () => [...identities.keys()], {
      getProcessMembers: async () => [],
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
      kill,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(child.pid, child);
    const started = Date.now();
    const stopping = cleanup.stop(
      captured,
      async () => {
        /* Interrupt acknowledged. */
      },
      async () => {
        if (Date.now() >= started + 4975 && Date.now() < started + 5000) {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
        }
        return identities.has(child.pid);
      },
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    await expect(stopping).resolves.toBe(started + 7000);
    expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGKILL");
    expect(identities.get(root.pid)).toEqual(root);
  });

  it("finds a reparented background member through the verified pane group", async () => {
    vi.useFakeTimers();
    const orphan = { ...child, pgid: root.pgid, sid: root.sid };
    const identities = new Map([[root.pid, root]]);
    const kill = vi.fn((pid: number) => {
      identities.delete(pid);
    });
    const cleanup = new PaneCleanup(async () => [root.pid], {
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
      getProcessMembers: async () => [...identities.values()],
      kill,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(orphan.pid, orphan);
    const stopping = cleanup.stop(
      captured,
      async () => {
        /* Interrupt acknowledged. */
      },
      async () => false,
    );
    await vi.advanceTimersByTimeAsync(5100);
    await stopping;
    expect(kill).toHaveBeenCalledExactlyOnceWith(orphan.pid, "SIGKILL");
    expect(identities.get(root.pid)).toEqual(root);
  });
  it("preserves an unchanged prelaunch job while killing the new execution", async () => {
    vi.useFakeTimers();
    const previous = { ...child, pid: 125, pgid: 125, startTime: "previous" };
    const identities = new Map([
      [root.pid, root],
      [previous.pid, previous],
    ]);
    const kill = vi.fn((pid: number) => {
      identities.delete(pid);
    });
    const cleanup = new PaneCleanup(async () => [...identities.keys()], {
      getProcessMembers: async () => [],
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
      kill,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(child.pid, child);
    const stopping = cleanup.stop(
      captured,
      async () => {
        /* Interrupt acknowledged. */
      },
      async () => {
        const candidates = await cleanup.candidates(captured, [...identities.keys()]);
        return candidates.some((pid) => pid !== root.pid);
      },
    );
    await vi.advanceTimersByTimeAsync(5100);
    await stopping;
    expect(kill).toHaveBeenCalledExactlyOnceWith(child.pid, "SIGKILL");
    expect(identities.get(previous.pid)).toEqual(previous);
  });
  it("accepts duplicate ownership ACKs but rejects a reused registered group leader", async () => {
    const identities = new Map([[root.pid, root]]);
    const cleanup = new PaneCleanup(async () => [...identities.keys()], {
      getProcessMembers: async () => [],
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(child.pid, child);
    await cleanup.register(captured, child.pid);
    await cleanup.register(captured, child.pid);
    identities.set(child.pid, { ...child, startTime: "reused" });
    await expect(cleanup.register(captured, child.pid)).rejects.toThrow("identity changed");
  });
  it("registers a same-group keeper and rejects a different session", async () => {
    const identities = new Map([[root.pid, root]]);
    const cleanup = new PaneCleanup(async () => [...identities.keys()], {
      getProcessMembers: async () => [],
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(child.pid, child);
    const keeper = { ...child, pid: 125, startTime: "keeper" };
    identities.set(keeper.pid, keeper);
    await cleanup.register(captured, child.pid, keeper.pid);
    const ownership = await captured;
    expect(ownership.members.get(keeper.pid)).toEqual(keeper);
    identities.set(keeper.pid, { ...keeper, sid: 999 });
    await expect(cleanup.register(captured, child.pid, keeper.pid)).rejects.toThrow(
      "keeper unverifiable",
    );
  });
  it("refreshes a verified service group after its pane disappears", async () => {
    vi.useFakeTimers();
    const identities = new Map([[root.pid, root]]);
    const orphan = { ...child, pid: 125, startTime: "orphan" };
    const kill = vi.fn((pid: number) => {
      identities.delete(pid);
    });
    const cleanup = new PaneCleanup(async () => [...identities.keys()], {
      readProcessIdentity: async (pid) => identities.get(pid) ?? null,
      getProcessMembers: async (identity) =>
        [...identities.values()].filter(
          (member) => member.pgid === identity.pgid && member.sid === identity.sid,
        ),
      kill,
    });
    const captured = Promise.resolve(await cleanup.capture(Promise.resolve(root.pid)));
    identities.set(child.pid, child);
    await cleanup.register(captured, child.pid);
    const stopping = cleanup.stop(
      captured,
      async () => {
        identities.delete(root.pid);
        identities.set(orphan.pid, orphan);
      },
      async () => false,
    );
    await vi.advanceTimersByTimeAsync(5100);
    await stopping;
    expect(kill).toHaveBeenCalledWith(child.pid, "SIGKILL");
    expect(kill).toHaveBeenCalledWith(orphan.pid, "SIGKILL");
    expect(identities.size).toBe(0);
  });
});
