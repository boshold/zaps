import { describe, expect, it, vi } from "vitest";

import { detachManagedClient } from "../../src/lib/managed-detach.js";

describe("detachManagedClient", () => {
  it("detaches the client attached to this pane in managed mode", async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    await expect(detachManagedClient({ managedEnv: "1", paneTarget: "%7", detach })).resolves.toBe(
      true,
    );
    // Targeting the PANE, not the session: only this client goes away.
    expect(detach).toHaveBeenCalledWith("%7");
  });

  it("does nothing in a personal tmux session", async () => {
    const detach = vi.fn();
    await expect(
      detachManagedClient({ managedEnv: undefined, paneTarget: "%7", detach }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it("only honors an exact ZAPS_MANAGED_TMUX=1", async () => {
    const detach = vi.fn();
    await expect(detachManagedClient({ managedEnv: "0", paneTarget: "%7", detach })).resolves.toBe(
      false,
    );
    expect(detach).not.toHaveBeenCalled();
  });

  it("does nothing without a pane to target", async () => {
    const detach = vi.fn();
    await expect(
      detachManagedClient({ managedEnv: "1", paneTarget: undefined, detach }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it("never lets a tmux failure block quitting", async () => {
    const detach = vi.fn().mockRejectedValue(new Error("no client found"));
    await expect(detachManagedClient({ managedEnv: "1", paneTarget: "%7", detach })).resolves.toBe(
      false,
    );
  });
});
