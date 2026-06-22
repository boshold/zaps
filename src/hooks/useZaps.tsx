import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { DaemonClient } from "#src/client/daemon-client.js";
import { resolveUiConfig } from "#src/config/index.js";
import type { ResolvedUiConfig } from "#src/config/index.js";
import type { ServiceMeta, SessionSnapshot, TaskInfo } from "#src/daemon/session.js";

type PaneMap = Record<string, string>;

/** Fallback when no resolved UI config is supplied (e.g. isolated tests). */
const DEFAULT_RESOLVED_UI = resolveUiConfig();

interface AppContextValue {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  configStale: boolean;
  /** Resolved TUI config (icons, wideThreshold, notifications, …). */
  ui: ResolvedUiConfig;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  client,
  paneMap: initialPaneMap,
  projectName: initialProjectName,
  tasks: initialTasks,
  servicesMeta: initialServicesMeta,
  configStale: initialConfigStale = false,
  ui = DEFAULT_RESOLVED_UI,
  children,
}: {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  configStale?: boolean;
  ui?: ResolvedUiConfig;
  children: ReactNode;
}) {
  const [paneMap, setPaneMap] = useState(initialPaneMap);
  const [projectName, setProjectName] = useState(initialProjectName);
  const [tasks, setTasks] = useState(initialTasks);
  const [servicesMeta, setServicesMeta] = useState(initialServicesMeta);
  const [configStale, setConfigStale] = useState(initialConfigStale);

  useEffect(() => {
    function handleReload(snapshot: SessionSnapshot) {
      setPaneMap(snapshot.paneMap);
      setProjectName(snapshot.name);
      setTasks(snapshot.tasks);
      setServicesMeta(snapshot.servicesMeta);
      // A successful reload clears the staleness hint.
      setConfigStale(false);
    }
    function handleStale() {
      setConfigStale(true);
    }
    client.on("session.configReloaded", handleReload);
    client.on("session.configStale", handleStale);
    return () => {
      client.off("session.configReloaded", handleReload);
      client.off("session.configStale", handleStale);
    };
  }, [client]);

  const value = useMemo(
    () => ({ client, paneMap, projectName, tasks, servicesMeta, configStale, ui }),
    [client, paneMap, projectName, tasks, servicesMeta, configStale, ui],
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
