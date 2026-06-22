import { createContext, useContext } from "react";

/** Measured body dimensions provided by `FullscreenLayout` to its children. */
interface ViewportSize {
  /** Measured body height in cell rows — lists window to this. */
  height: number;
  /** Measured body width in cells. */
  width: number;
}

const ViewportContext = createContext<ViewportSize | null>(null);

const ViewportProvider = ViewportContext.Provider;

/**
 * Read the measured body dimensions from the nearest `FullscreenLayout`.
 * Throws if used outside one so a missing provider fails loudly instead of
 * silently windowing to a zero height.
 */
function useViewportSize(): ViewportSize {
  const ctx = useContext(ViewportContext);
  if (!ctx) {
    throw new Error("useViewportSize must be used within a FullscreenLayout");
  }
  return ctx;
}

export { ViewportProvider, useViewportSize };
export type { ViewportSize };
