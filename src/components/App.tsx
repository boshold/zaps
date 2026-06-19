import { useMemo } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";
import { resolveUiConfig } from "#src/config/index.js";
import type { UiConfig } from "#src/config/types.js";
import type { ServiceMeta, TaskInfo } from "#src/daemon/session.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { Router } from "./Router.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { IconThemeProvider, createIconTheme, resolveIconTier } from "./theme/IconTheme.js";

type PaneMap = Record<string, string>;

interface AppProps {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  initialStatuses: ServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
  configStale?: boolean;
  ui?: UiConfig;
}

export function App({
  client,
  paneMap,
  projectName,
  tasks,
  servicesMeta,
  initialStatuses,
  initialTaskHistory,
  autoStart,
  configStale,
  ui,
}: AppProps) {
  // Resolve UI config + icon tier once at the root (env override wins over config).
  // Memoized for stable context identity across re-renders.
  const resolvedUi = useMemo(() => resolveUiConfig(ui), [ui]);
  const iconTheme = useMemo(() => createIconTheme(resolveIconTier(resolvedUi.icons)), [resolvedUi]);

  return (
    <IconThemeProvider value={iconTheme}>
      <AppProvider
        client={client}
        paneMap={paneMap}
        projectName={projectName}
        tasks={tasks}
        servicesMeta={servicesMeta}
        configStale={configStale}
        ui={resolvedUi}
      >
        <Router
          initialStatuses={initialStatuses}
          initialTaskHistory={initialTaskHistory}
          autoStart={autoStart}
        />
      </AppProvider>
    </IconThemeProvider>
  );
}
