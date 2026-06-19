import { OverlayProvider } from "#src/hooks/useOverlay.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { OverlayHost } from "./overlay/OverlayHost.js";
import { Router } from "./Router.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

interface AppShellProps {
  initialStatuses: ServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}

/**
 * Mounts the overlay stack around the Router so overlays float above the base
 * view. Kept separate from `App` to keep each component's JSX nesting shallow.
 */
export function AppShell({ initialStatuses, initialTaskHistory, autoStart }: AppShellProps) {
  return (
    <OverlayProvider>
      <Router
        initialStatuses={initialStatuses}
        initialTaskHistory={initialTaskHistory}
        autoStart={autoStart}
      />
      <OverlayHost />
    </OverlayProvider>
  );
}
