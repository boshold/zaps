import { useMemo } from "react";

import { useZaps } from "#src/hooks/useZaps.js";

import { OverlayHost } from "./overlay/OverlayHost.js";
import { Router } from "./Router.js";
import { ShellProviders } from "./ShellProviders.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { IconThemeProvider, createIconTheme, resolveIconTier } from "./theme/IconTheme.js";

interface AppShellProps {
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
}

/**
 * Mounts the overlay stack around the Router so it floats above the base view.
 * Toast notifications are rendered in-flow by the dashboard footer
 * ({@link DashboardToasts}), not as an absolute sibling here — a bottom-anchored
 * float overprinted the service list on short panes.
 */
export function AppShell({ initialTaskHistory, autoStart }: AppShellProps) {
  const { ui } = useZaps();
  const theme = useMemo(() => createIconTheme(resolveIconTier(ui.icons)), [ui.icons]);
  return (
    <IconThemeProvider value={theme}>
      <ShellProviders>
        <Router initialTaskHistory={initialTaskHistory} autoStart={autoStart} />
        <OverlayHost />
      </ShellProviders>
    </IconThemeProvider>
  );
}
