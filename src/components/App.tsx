import type { ResolvedConfig } from "#src/config/types.js";
import { AppProvider } from "#src/hooks/useZaps.js";
import type { ServiceManager } from "#src/lib/service/manager.js";

import { Router } from "./Router.js";

type PaneMap = Record<string, string>;

interface AppProps {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
}

export function App({ manager, config, paneMap }: AppProps) {
  return (
    <AppProvider manager={manager} config={config} paneMap={paneMap}>
      <Router />
    </AppProvider>
  );
}
