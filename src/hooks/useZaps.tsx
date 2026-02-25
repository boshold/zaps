import type { DaemonClient } from "#src/client/daemon-client.js";
/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { ResolvedConfig } from "#src/config/types.js";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

type PaneMap = Record<string, string>;

interface AppContextValue {
  client: DaemonClient;
  config: ResolvedConfig;
  paneMap: PaneMap;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  client,
  config,
  paneMap,
  children,
}: {
  client: DaemonClient;
  config: ResolvedConfig;
  paneMap: PaneMap;
  children: ReactNode;
}) {
  return <AppContext.Provider value={{ client, config, paneMap }}>{children}</AppContext.Provider>;
}

export function useZaps(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useZaps must be used within AppProvider");
  }
  return ctx;
}
