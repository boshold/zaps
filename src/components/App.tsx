import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ServiceMeta, TaskInfo } from "#src/daemon/session.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { Router } from "./Router.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

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
}: AppProps) {
  return (
    <AppProvider
      client={client}
      paneMap={paneMap}
      projectName={projectName}
      tasks={tasks}
      servicesMeta={servicesMeta}
      configStale={configStale}
    >
      <Router
        initialStatuses={initialStatuses}
        initialTaskHistory={initialTaskHistory}
        autoStart={autoStart}
      />
    </AppProvider>
  );
}
