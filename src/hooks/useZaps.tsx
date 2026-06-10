import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ServiceMeta, SessionSnapshot, TaskInfo } from "#src/daemon/session.js";

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
  paneMap: initialPaneMap,
  projectName: initialProjectName,
  tasks: initialTasks,
  servicesMeta: initialServicesMeta,
  children,
}: {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  children: ReactNode;
}) {
  const [paneMap, setPaneMap] = useState(initialPaneMap);
  const [projectName, setProjectName] = useState(initialProjectName);
  const [tasks, setTasks] = useState(initialTasks);
  const [servicesMeta, setServicesMeta] = useState(initialServicesMeta);

  useEffect(() => {
    function handleReload(snapshot: SessionSnapshot) {
      setPaneMap(snapshot.paneMap);
      setProjectName(snapshot.name);
      setTasks(snapshot.tasks);
      setServicesMeta(snapshot.servicesMeta);
    }
    client.on("session.configReloaded", handleReload);
    return () => {
      client.off("session.configReloaded", handleReload);
    };
  }, [client]);

  const value = useMemo(
    () => ({ client, paneMap, projectName, tasks, servicesMeta }),
    [client, paneMap, projectName, tasks, servicesMeta],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useZaps(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useZaps must be used within AppProvider");
  }
  return ctx;
}
