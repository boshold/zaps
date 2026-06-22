import { measureElement } from "ink";
import type { DOMElement } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useDimensions } from "./useDimensions.js";

export interface Viewport {
  /** Attach to the `flexGrow={1}` body Box whose height should be measured. */
  ref: RefObject<DOMElement | null>;
  /** Measured body height in cell rows. Seeded from `rows − estimatedChrome` for the first tick. */
  height: number;
  /** Measured body width in cells. Seeded from terminal `cols` for the first tick. */
  width: number;
}

/**
 * Measure the available body height at runtime instead of computing it
 * arithmetically. `measureElement` returns `{0,0}` before Yoga has laid the tree
 * out, so we seed from {@link useDimensions} (`rows − estimatedChrome`) for the
 * first paint, then overwrite with the real measurement once `useLayoutEffect`
 * fires. This removes the v1 `chromeRows`/`rows - 4` math that blanked the pane.
 *
 * @param deps - extra dependencies that should trigger a re-measure (e.g. layout-affecting state).
 * @param estimatedChrome - rows reserved for header/footer chrome in the first-tick fallback.
 */
export function useViewport(deps: unknown[] = [], estimatedChrome = 4): Viewport {
  const { rows, cols } = useDimensions();
  const ref = useRef<DOMElement>(null);
  const [size, setSize] = useState(() => ({
    height: Math.max(0, rows - estimatedChrome),
    width: cols,
  }));

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const { width, height } = measureElement(node);
    // MeasureElement yields {0,0} before layout is computed — keep the fallback
    // For that tick rather than blanking the body with a zero height.
    if (width <= 0 && height <= 0) {
      return;
    }
    // Only write state when the measurement actually changed to avoid a render loop.
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    // Rows/cols cover terminal resize; spread deps lets callers force a re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, ...deps]);

  return { ref, height: size.height, width: size.width };
}
