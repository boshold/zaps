import { describe, expect, it, vi } from "vitest";

import { detachManagedClient } from "../../src/lib/managed-detach.js";

describe("detachManagedClient", () => {
  it("detaches the client attached to this pane in managed mode", async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    await expect(
      detachManagedClient({ managedEnv: "1", tmuxEnv: "/tmp/tmux-1000/zaps,42,0", detach }),
    ).resolves.toBe(true);
    // No target: `-t` on detach-client means a client TTY, never a pane, so the
    // Current client is resolved from `$TMUX` instead.
    expect(detach).toHaveBeenCalledWith();
  });

  it("does nothing in a personal tmux session", async () => {
    const detach = vi.fn();
    await expect(
      detachManagedClient({ managedEnv: undefined, tmuxEnv: "/tmp/tmux-1000/zaps,42,0", detach }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it("only honors an exact ZAPS_MANAGED_TMUX=1", async () => {
    const detach = vi.fn();
    await expect(
      detachManagedClient({ managedEnv: "0", tmuxEnv: "/tmp/tmux-1000/zaps,42,0", detach }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it("does nothing outside tmux (no client to resolve)", async () => {
    const detach = vi.fn();
    await expect(
      detachManagedClient({ managedEnv: "1", tmuxEnv: undefined, detach }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it("never lets a tmux failure block quitting", async () => {
    const detach = vi.fn().mockRejectedValue(new Error("no client found"));
    await expect(
      detachManagedClient({ managedEnv: "1", tmuxEnv: "/tmp/tmux-1000/zaps,42,0", detach }),
    ).resolves.toBe(false);
  });
});
