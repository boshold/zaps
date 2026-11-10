import { useMemo } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";
import { resolveUiConfig } from "#src/config/index.js";
import type { UiConfig } from "#src/config/types.js";
import type {
  ProjectedServiceStatus,
  ServiceMeta,
  SessionSnapshot,
  TaskInfo,
} from "#src/daemon/session.js";
import { AppProvider } from "#src/hooks/useZaps.js";

import { AppShell } from "./AppShell.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

type PaneMap = Record<string, string>;

interface AppProps {
  backend?: SessionSnapshot["backend"];
  capabilities?: SessionSnapshot["capabilities"];
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  initialStatuses: ProjectedServiceStatus[];
  initialTaskHistory: TaskRunRecord[];
  autoStart?: boolean;
  configStale?: boolean;
  ui?: UiConfig;
}

export function App({
  client,
  backend,
  capabilities,
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

  return (
    <AppProvider
      client={client}
      paneMap={paneMap}
      backend={backend}
      capabilities={capabilities}
      statuses={initialStatuses}
      projectName={projectName}
      tasks={tasks}
      servicesMeta={servicesMeta}
      configStale={configStale}
      ui={resolvedUi}
    >
      <AppShell initialTaskHistory={initialTaskHistory} autoStart={autoStart} />
    </AppProvider>
  );
}
