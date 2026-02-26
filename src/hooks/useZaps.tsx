/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ServiceMeta, TaskInfo } from "#src/daemon/session.js";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

type PaneMap = Record<string, string>;

interface AppContextValue {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  client,
  paneMap,
  projectName,
  tasks,
  servicesMeta,
  children,
}: {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  children: ReactNode;
}) {
  return (
    <AppContext.Provider value={{ client, paneMap, projectName, tasks, servicesMeta }}>
      {children}
    </AppContext.Provider>
  );
}

export function useZaps(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useZaps must be used within AppProvider");
  }
  return ctx;
}
