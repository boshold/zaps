import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ServiceMeta, TaskInfo } from "#src/daemon/session.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { Router } from "./Router.js";

type PaneMap = Record<string, string>;

interface AppProps {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  initialStatuses: ServiceStatus[];
  autoStart?: boolean;
}

export function App({
  client,
  paneMap,
  projectName,
  tasks,
  servicesMeta,
  initialStatuses,
  autoStart,
}: AppProps) {
  return (
    <AppProvider
      client={client}
      paneMap={paneMap}
      projectName={projectName}
      tasks={tasks}
      servicesMeta={servicesMeta}
    >
      <Router initialStatuses={initialStatuses} autoStart={autoStart} />
    </AppProvider>
  );
}
