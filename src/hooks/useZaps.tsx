import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

/* eslint-disable eslint-plugin-react/only-export-components -- Provider + hook co-located by design */
import type { DaemonClient } from "#src/client/daemon-client.js";
import { resolveUiConfig } from "#src/config/index.js";
import type { ResolvedUiConfig } from "#src/config/index.js";
import type {
  ProjectedServiceStatus,
  ServiceMeta,
  SessionSnapshot,
  TaskInfo,
} from "#src/daemon/session.js";
import { useConnection } from "#src/hooks/useConnection.js";
import { useServices } from "#src/hooks/useServices.js";
import { unavailableCapabilities } from "#src/lib/backend/wire.js";

type PaneMap = Record<string, string>;

/** Fallback when no resolved UI config is supplied (e.g. isolated tests). */
const DEFAULT_RESOLVED_UI = resolveUiConfig();
const EMPTY_STATUSES: ProjectedServiceStatus[] = [];

interface AppContextValue {
  backend: SessionSnapshot["backend"];
  capabilities: SessionSnapshot["capabilities"];
  statuses: ProjectedServiceStatus[];
  connected: boolean;
  retry: () => void;
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
  ui: initialUi = DEFAULT_RESOLVED_UI,
  backend: initialBackend = "tmux",
  capabilities: initialCapabilities = unavailableCapabilities,
  statuses: initialStatuses = EMPTY_STATUSES,
  children,
}: {
  client: DaemonClient;
  paneMap: PaneMap;
  projectName: string;
  tasks: TaskInfo[];
  servicesMeta: ServiceMeta[];
  backend?: SessionSnapshot["backend"];
  capabilities?: SessionSnapshot["capabilities"];
  statuses?: ProjectedServiceStatus[];
  configStale?: boolean;
  ui?: ResolvedUiConfig;
  children: ReactNode;
}) {
  const [backend, setBackend] = useState(initialBackend);
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const { connected, retry } = useConnection(client);
  const statuses = useServices(client, initialStatuses, connected);
  const [ui, setUi] = useState(initialUi);
  const [paneMap, setPaneMap] = useState(initialPaneMap);
  const [projectName, setProjectName] = useState(initialProjectName);
  const [tasks, setTasks] = useState(initialTasks);
  const [servicesMeta, setServicesMeta] = useState(initialServicesMeta);
  const [configStale, setConfigStale] = useState(initialConfigStale);

  useEffect(() => {
    function handleSnapshot(snapshot: SessionSnapshot) {
      setPaneMap(snapshot.paneMap);
      setProjectName(snapshot.name);
      setTasks(snapshot.tasks);
      setServicesMeta(snapshot.servicesMeta);
      setConfigStale(snapshot.configStale);
      setBackend(snapshot.backend);
      setCapabilities(snapshot.capabilities);
      setUi(resolveUiConfig(snapshot.ui));
    }
    function handleStale() {
      setConfigStale(true);
    }
    client.on("session.paneMap", setPaneMap);
    client.on("session.snapshot", handleSnapshot);
    client.on("session.configReloaded", handleSnapshot);
    client.on("session.configStale", handleStale);
    return () => {
      client.off("session.paneMap", setPaneMap);
      client.off("session.snapshot", handleSnapshot);
      client.off("session.configReloaded", handleSnapshot);
      client.off("session.configStale", handleStale);
    };
  }, [client]);

  const value = useMemo(
    () => ({
      client,
      backend,
      capabilities,
      statuses,
      connected,
      retry,
      paneMap,
      projectName,
      tasks,
      servicesMeta,
      configStale,
      ui,
    }),
    [
      client,
      backend,
      capabilities,
      statuses,
      connected,
      retry,
      paneMap,
      projectName,
      tasks,
      servicesMeta,
      configStale,
      ui,
    ],
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
