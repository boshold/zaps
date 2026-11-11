import { useEffect, useRef, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";
import type { ProjectedServiceStatus, SessionSnapshot } from "#src/daemon/session.js";

export function useServices(
  client: DaemonClient,
  initialStatuses: ProjectedServiceStatus[],
  connected = true,
) {
  const [statuses, setStatuses] = useState(initialStatuses);
  // Bumped on every event-driven update. A 2s poll captures the epoch when it
  // Starts and discards its response if an event landed meanwhile, so a slow
  // Poll can't overwrite fresher state with a stale snapshot (F9).
  const epochRef = useRef(0);

  useEffect(() => {
    function onStateChange(_name: string, status: ProjectedServiceStatus) {
      epochRef.current += 1;
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
      epochRef.current += 1;
      setStatuses(snapshot.statuses);
    }
    function onLost() {
      epochRef.current += 1;
    }
    client.on("disconnect", onLost);
    client.on("session.destroyed", onLost);
    client.on("session.snapshot", onReload);
    client.on("service.stateChange", onStateChange);
    client.on("session.configReloaded", onReload);
    return () => {
      epochRef.current += 1;
      client.off("disconnect", onLost);
      client.off("session.destroyed", onLost);
      client.off("session.snapshot", onReload);
      client.off("service.stateChange", onStateChange);
      client.off("session.configReloaded", onReload);
    };
  }, [client]);

  // Poll every 2s for port updates (ports may change without state events).
  // While disconnected we deliberately stop polling — last-known state is frozen
  // (and dimmed behind the banner) rather than the poll silently failing every 2s.
  useEffect(() => {
    epochRef.current += 1;
    if (!connected) {
      return;
    }
    const id = setInterval(() => {
      const startEpoch = epochRef.current;
      void (async () => {
        try {
          const result = await client.listServices();
          // Discard if an event-driven update raced ahead while the poll was in flight.
          if (epochRef.current === startEpoch) {
            setStatuses(result);
          }
        } catch {
          // Poll failed — ignore
        }
      })();
    }, 2000);
    return () => {
      epochRef.current += 1;
      clearInterval(id);
    };
  }, [client, connected]);

  return statuses;
}
