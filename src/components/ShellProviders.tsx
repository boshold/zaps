import type { ReactNode } from "react";

import { OverlayProvider } from "#src/hooks/useOverlay.js";
import { ToastProvider } from "#src/hooks/useToasts.js";

/**
 * Overlay + toast context providers wrapping the shell. Split into its own file
 * so neither this nor {@link AppShell} exceeds the JSX nesting-depth lint limit.
 */
export function ShellProviders({ children }: { children: ReactNode }) {
  return (
    <OverlayProvider>
      <ToastProvider>{children}</ToastProvider>
    </OverlayProvider>
  );
}
