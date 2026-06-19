import type { ReactNode } from "react";
import { createContext, createElement, useCallback, useContext, useMemo, useState } from "react";

/** A modal overlay entry: an id plus a render thunk (component + props, no logic). */
interface OverlayDescriptor {
  id: string;
  render: () => ReactNode;
}

interface OverlayApi {
  /** The LIFO stack, bottom-to-top. */
  stack: OverlayDescriptor[];
  /** Push an overlay onto the top. Re-pushing an existing id moves it to the top. */
  push: (overlay: OverlayDescriptor) => void;
  /** Pop the top overlay (also bound to Esc by `OverlayHost`). */
  pop: () => void;
  /** The current top overlay, or null when the stack is empty. */
  top: OverlayDescriptor | null;
  /** `stack.length > 0` — true while any overlay is open. */
  isOpen: boolean;
  /** Whether the given id owns the top of the stack — each overlay gates input on this. */
  isTop: (id: string) => boolean;
}

const OverlayContext = createContext<OverlayApi | null>(null);

// Inert fallback for consumers rendered without a provider (isolated component
// Tests). The app root always mounts a real `OverlayProvider`; this keeps the
// Base view's `isActive: !isOpen` gating sane outside one rather than throwing.
const NOOP_OVERLAY: OverlayApi = {
  stack: [],
  push: () => undefined,
  pop: () => undefined,
  top: null,
  isOpen: false,
  isTop: () => false,
};

/**
 * Owns the LIFO overlay stack and provides it to the tree. The base view gates
 * its input on `!isOpen`; each overlay gates on `isTop(id)`, so only the top
 * overlay is interactive.
 */
function OverlayProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<OverlayDescriptor[]>([]);

  const push = useCallback((overlay: OverlayDescriptor) => {
    setStack((prev) => [...prev.filter((o) => o.id !== overlay.id), overlay]);
  }, []);

  const pop = useCallback(() => {
    setStack((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
  }, []);

  const value = useMemo<OverlayApi>(() => {
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    return {
      stack,
      push,
      pop,
      top,
      isOpen: stack.length > 0,
      isTop: (id) => top?.id === id,
    };
  }, [stack, push, pop]);

  return createElement(OverlayContext.Provider, { value }, children);
}

/** Read the overlay stack API. Returns an inert API when no provider is mounted. */
function useOverlay(): OverlayApi {
  return useContext(OverlayContext) ?? NOOP_OVERLAY;
}

export { OverlayProvider, useOverlay };
export type { OverlayApi, OverlayDescriptor };
