import { useInput } from "ink";
import type { ReactNode } from "react";

import { useOverlay } from "#src/hooks/useOverlay.js";

/**
 * Renders the top overlay of the LIFO stack (conditional render — only the top
 * is mounted) and binds Esc to pop it. Positioning is the descriptor's own
 * concern: a centered palette uses `position="absolute"`, an inline overlay
 * renders in place. The host stays layout-agnostic.
 */
export function OverlayHost(): ReactNode {
  const { top, pop, isOpen } = useOverlay();

  // Host-level Esc pops the top overlay. Active only while the stack is non-empty
  // So the base view's own Esc handlers keep working when nothing is open.
  useInput(
    (_input, key) => {
      if (key.escape) {
        pop();
      }
    },
    { isActive: isOpen },
  );

  return top ? top.render() : null;
}
