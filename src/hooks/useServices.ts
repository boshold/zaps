/* eslint-disable eslint-plugin-promise/prefer-await-to-then -- useEffect cannot be async */
import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import { useEffect, useState } from "react";

export function useServices(client: DaemonClient, initialStatuses: ServiceStatus[]) {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(initialStatuses);

  useEffect(() => {
    function onStateChange(_name: string, status: ServiceStatus) {
      setStatuses((prev) => {
        const idx = prev.findIndex((s) => s.name === status.name);
        if (idx === -1) {
          return prev;
        }
        const next = [...prev];
        next[idx] = status;
        return next;
      });
    }
    client.on("service.stateChange", onStateChange);
    return () => {
      client.off("service.stateChange", onStateChange);
    };
  }, [client]);

  // Poll every 2s for port updates (ports may change without state events)
  useEffect(() => {
    const id = setInterval(() => {
      // eslint-disable-next-line no-void -- Fire-and-forget poll
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
