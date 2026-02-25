import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ResolvedConfig } from "#src/config/types.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { Router } from "./Router.js";

type PaneMap = Record<string, string>;

interface AppProps {
  client: DaemonClient;
  config: ResolvedConfig;
  paneMap: PaneMap;
  initialStatuses: ServiceStatus[];
  autoStart?: boolean;
}

export function App({ client, config, paneMap, initialStatuses, autoStart }: AppProps) {
  return (
    <AppProvider client={client} config={config} paneMap={paneMap}>
      <Router initialStatuses={initialStatuses} autoStart={autoStart} />
    </AppProvider>
  );
}
