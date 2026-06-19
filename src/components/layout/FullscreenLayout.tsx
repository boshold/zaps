import { Box } from "ink";
import type { ReactNode } from "react";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useViewport } from "#src/hooks/useViewport.js";

import { ViewportProvider } from "./ViewportContext.js";

export interface FullscreenLayoutProps {
  /** Fixed-height chrome above the body (natural height). */
  header?: ReactNode;
  /** Fixed-height chrome below the body — hints + toast slot (natural height). */
  footer?: ReactNode;
  /** Body content; rendered in a `flexGrow={1}` box whose height is measured. */
  children: ReactNode;
}

/**
 * The single layout primitive every view uses: a full-terminal-height column of
 * fixed `header`, a `flexGrow={1}` measured body, and fixed `footer`. The body
 * height is **measured** via {@link useViewport} (never arithmetic) and exposed
 * to children through {@link ViewportProvider}, so lists window to the real
 * available space. `overflowY="hidden"` clips any residual overflow so a one-row
 * measurement error can never drift the alt-screen cursor or blank the pane.
 */
export function FullscreenLayout({ header, footer, children }: FullscreenLayoutProps) {
  const { rows } = useDimensions();
  // Re-measure when the chrome content changes, not just on terminal resize.
  const { ref, height, width } = useViewport([header, footer]);

  return (
    <Box flexDirection="column" height={rows}>
      {/* FlexShrink={0} guarantees the chrome keeps its full height even under
          pathological body overflow, so it can never be shrunk away. */}
      {header && (
        <Box flexShrink={0} flexDirection="column">
          {header}
        </Box>
      )}
      {/* MinHeight={0} overrides flex's implicit min-content floor so flexGrow
          truly constrains the body to the leftover rows and overflowY clips
          residual overflow — the anti-blank safety net on top of measured sizing. */}
      <Box ref={ref} flexGrow={1} minHeight={0} overflowY="hidden">
        <ViewportProvider value={{ height, width }}>{children}</ViewportProvider>
      </Box>
      {footer && (
        <Box flexShrink={0} flexDirection="column">
          {footer}
        </Box>
      )}
    </Box>
  );
}
