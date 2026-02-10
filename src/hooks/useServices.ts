import type { ServiceManager } from "../lib/service/manager.js";
import type { ServiceStatus } from "../lib/service/types.js";
import { useEffect, useState } from "react";

export function useServices(manager: ServiceManager) {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(() => manager.getAllStatuses());

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
