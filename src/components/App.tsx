// eslint-disable-next-line import/no-relative-parent-imports -- Components need config types
import type { ResolvedConfig } from "../config/types.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need service manager type
import type { ServiceManager } from "../lib/service/manager.js";
import { Text } from "ink";

// eslint-disable-next-line import/no-relative-parent-imports -- Components need router hook
import { useRouter } from "../hooks/useRouter.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need selection hook
import { useSelection } from "../hooks/useSelection.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need services hook
import { useServices } from "../hooks/useServices.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Components need app context
import { AppProvider, useZaps } from "../hooks/useZaps.js";

import { Dashboard } from "./Dashboard.js";

type PaneMap = Record<string, string>;

interface AppProps {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
}

function Router() {
  const { view } = useRouter();
  const { manager } = useZaps();
  const statuses = useServices(manager);
  const { index } = useSelection(statuses.length);

  if (view === "dashboard") {
    return <Dashboard statuses={statuses} selectedIndex={index} />;
  }
  if (view === "tasks") {
    return <Text>Tasks view (not yet implemented)</Text>;
  }
  if (view === "logs") {
    return <Text>Logs view (not yet implemented)</Text>;
  }
  return null;
}

// eslint-disable-next-line react/no-multi-comp -- Router is an internal helper, spec allows inline
export function App({ manager, config, paneMap }: AppProps) {
  return (
    <AppProvider manager={manager} config={config} paneMap={paneMap}>
      <Router />
    </AppProvider>
  );
}
