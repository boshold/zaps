import type { ServiceStatus } from "#src/lib/service/types.js";

import { OverlayHost } from "./overlay/OverlayHost.js";
import { Router } from "./Router.js";
import { ShellProviders } from "./ShellProviders.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

interface AppShellProps {
  initialStatuses: ServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}

/**
 * Mounts the overlay stack around the Router so it floats above the base view.
 * Toast notifications are rendered in-flow by the dashboard footer
 * ({@link DashboardToasts}), not as an absolute sibling here — a bottom-anchored
 * float overprinted the service list on short panes.
 */
export function AppShell({ initialStatuses, initialTaskHistory, autoStart }: AppShellProps) {
  return (
    <ShellProviders>
      <Router
        initialStatuses={initialStatuses}
        initialTaskHistory={initialTaskHistory}
        autoStart={autoStart}
      />
      <OverlayHost />
    </ShellProviders>
  );
}
