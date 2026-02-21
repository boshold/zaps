import type { ResolvedConfig } from "#src/config/types.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceManager } from "#src/lib/service/manager.js";

import { Router } from "./Router.js";

type PaneMap = Record<string, string>;

interface AppProps {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
  autoStart?: boolean;
}

export function App({ manager, config, paneMap, autoStart }: AppProps) {
  return (
    <AppProvider manager={manager} config={config} paneMap={paneMap}>
      <Router autoStart={autoStart} />
    </AppProvider>
  );
}
