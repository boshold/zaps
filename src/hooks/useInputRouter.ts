import { useMemo } from "react";

import { useOverlay } from "#src/hooks/useOverlay.js";
import type { View } from "#src/hooks/useRouter.js";

/** Per-consumer `isActive` flags — exactly one base consumer is active at a time. */
interface InputRouterFlags {
  /** The overlay stack is non-empty; base views are inert and the top overlay owns input. */
  overlayOpen: boolean;
  /** Cross-view global keys (quit/shutdown, later palette/help). Inert while an overlay is open. */
  global: boolean;
  /** Dashboard owns input. */
  dashboard: boolean;
  /** LogView owns input. */
  logs: boolean;
  /** Tasks view owns input (transitional until the Phase 4 picker overlay). */
  tasks: boolean;
  /** Docker rebuild owns input (transitional until the T06 docker overlay). */
  dockerRebuild: boolean;
}

/**
 * Thin coordinator that derives which input consumer is active from the current
 * view, the overlay stack, and the ready/connected gates. It owns no key
 * handling itself — each view/overlay reads its flag and gates its own
 * `useInput({ isActive })`, so only one consumer ever responds to a key.
 */
function useInputRouter(
  view: View,
  opts: { ready: boolean; connected: boolean },
): InputRouterFlags {
  const { isOpen } = useOverlay();
  const { ready, connected } = opts;

  return useMemo(() => {
    // A base view owns input only when past the splash, connected, and nothing floats above it.
    const base = ready && connected && !isOpen;
    return {
      overlayOpen: isOpen,
      // Global keys survive a disconnect (so `q`/`r` still work) but yield to an open overlay.
      global: ready && !isOpen,
      dashboard: base && view === "dashboard",
      logs: base && view === "logs",
      tasks: base && view === "tasks",
      dockerRebuild: base && view === "dockerRebuild",
    };
  }, [view, ready, connected, isOpen]);
}

export { useInputRouter };
export type { InputRouterFlags };
