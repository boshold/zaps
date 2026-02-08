import { useEffect, useState } from "react";

// eslint-disable-next-line import/no-relative-parent-imports -- Hooks need service types
import type { ServiceStatus } from "../lib/service/types.js";
// eslint-disable-next-line import/no-relative-parent-imports -- Hooks need service manager type
import type { ServiceManager } from "../lib/service/manager.js";

export function useServices(manager: ServiceManager) {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(
    () => manager.getAllStatuses(),
  );

  useEffect(() => {
    function onStateChange(_name: string, _status: ServiceStatus) {
      setStatuses(manager.getAllStatuses());
    }
    manager.on("stateChange", onStateChange);
    return () => {
      manager.off("stateChange", onStateChange);
    };
  }, [manager]);

  // Also poll every 2s for port updates (ports change without state events)
  useEffect(() => {
    const id = setInterval(() => {
      setStatuses(manager.getAllStatuses());
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, [manager]);

  return statuses;
}
