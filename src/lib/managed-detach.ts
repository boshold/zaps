import { getEnv } from "./env.js";
import { detachClient } from "./tmux.js";

interface DetachDeps {
  /** `ZAPS_MANAGED_TMUX` — only `"1"` means "zaps owns this tmux session". */
  managedEnv: string | undefined;
  /** `TMUX_PANE` — the pane this process runs in, i.e. which client to detach. */
  paneTarget: string | undefined;
  detach: (paneTarget: string) => Promise<void>;
}

function defaultDeps(): DetachDeps {
  return {
    managedEnv: getEnv("ZAPS_MANAGED_TMUX"),
    paneTarget: getEnv("TMUX_PANE"),
    detach: detachClient,
  };
}

/**
 * Quit handling for a zaps-managed tmux session: detach the client so the user
 * lands back in the plain shell they ran `zaps` from, instead of being left in
 * a tmux session they never asked for. The TUI pane keeps `remain-on-exit on`
 * (set at create), so it is held dead at its layout position for the re-attach
 * revival while the services keep running.
 *
 * Returns true when a client was detached. In a personal tmux session — or with
 * no pane to target — this is a no-op and today's quit path is untouched.
 * Failures are swallowed on purpose: quitting must never be blocked by tmux.
 */
async function detachManagedClient(overrides: Partial<DetachDeps> = {}): Promise<boolean> {
  const deps = { ...defaultDeps(), ...overrides };
  if (deps.managedEnv !== "1" || !deps.paneTarget) {
    return false;
  }
  try {
    await deps.detach(deps.paneTarget);
    return true;
  } catch {
    // Already detached, or tmux is gone: exiting is still the right next step.
    return false;
  }
}

export { detachManagedClient };
export type { DetachDeps };
