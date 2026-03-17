import type { DaemonClient } from "#src/client/daemon-client.js";
import type { SessionSnapshot } from "#src/daemon/session.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { useEffect, useState } from "react";

export function useServices(client: DaemonClient, initialStatuses: ServiceStatus[]) {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(initialStatuses);

  useEffect(() => {
    function onStateChange(_name: string, status: ServiceStatus) {
      setStatuses((prev) => {
        const idx = prev.findIndex((s) => s.name === status.name);
        if (idx === -1) {
          // New service (from config reload) — append
          return [...prev, status];
        }
        const next = [...prev];
        next[idx] = status;
        return next;
      });
    }
    function onReload(snapshot: SessionSnapshot) {
      setStatuses(snapshot.statuses);
    }
    client.on("service.stateChange", onStateChange);
    client.on("session.configReloaded", onReload);
    return () => {
      client.off("service.stateChange", onStateChange);
      client.off("session.configReloaded", onReload);
    };
  }, [client]);

  // Poll every 2s for port updates (ports may change without state events)
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        try {
          const result = await client.listServices();
          setStatuses(result);
        } catch {
          // Poll failed — ignore
        }
      })();
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, [client]);

  return statuses;
}
