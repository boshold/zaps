/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { ResolvedConfig } from "../config/types.js";
import type { ServiceManager } from "../lib/service/manager.js";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

type PaneMap = Record<string, string>;

interface AppContextValue {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  manager,
  config,
  paneMap,
  children,
}: {
  manager: ServiceManager;
  config: ResolvedConfig;
  paneMap: PaneMap;
  children: ReactNode;
}) {
  return <AppContext.Provider value={{ manager, config, paneMap }}>{children}</AppContext.Provider>;
}

export function useZaps(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useZaps must be used within AppProvider");
  }
  return ctx;
}
