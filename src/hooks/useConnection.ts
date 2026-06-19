import { useCallback, useEffect, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";

export interface Connection {
  /** False once the daemon socket closes or the session is destroyed. */
  connected: boolean;
  /** Manually re-attach — there is no built-in reconnect (`r` in the UI). */
  retry: () => void;
}

/**
 * First consumer of the existing-but-unused `DaemonClient` `disconnect` /
 * `session.destroyed` events + `connected` getter. Surfaces a `connected` flag
 * so the TUI can freeze/dim data and show a banner instead of silently
 * rendering stale state. No daemon changes are needed.
 */
export function useConnection(client: DaemonClient): Connection {
  const [connected, setConnected] = useState(() => client.connected);

  useEffect(() => {
    function onLost() {
      setConnected(false);
    }
    client.on("disconnect", onLost);
    client.on("session.destroyed", onLost);
    return () => {
      client.off("disconnect", onLost);
      client.off("session.destroyed", onLost);
    };
  }, [client]);

  const retry = useCallback(() => {
    // No built-in reconnect — re-invoke connect() to re-attach. Optimistically
    // Mark connected; if the socket closes again the disconnect handler resets it.
    client.connect();
    setConnected(true);
  }, [client]);

  return { connected, retry };
}
