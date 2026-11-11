import { useCallback, useEffect, useRef, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";

export interface Connection {
  connected: boolean;
  retry: () => void;
}

export function useConnection(client: DaemonClient): Connection {
  const [connected, setConnected] = useState(() => client.uiBound);
  const attempt = useRef(0);
  const retrying = useRef(false);

  useEffect(() => {
    setConnected(client.uiBound);
    function onLost() {
      attempt.current += 1;
      retrying.current = false;
      setConnected(false);
    }
    client.on("disconnect", onLost);
    client.on("session.destroyed", onLost);
    return () => {
      attempt.current += 1;
      client.off("disconnect", onLost);
      client.off("session.destroyed", onLost);
      if (retrying.current) {
        retrying.current = false;
        client.disconnect();
      }
    };
  }, [client]);

  const retry = useCallback(() => {
    attempt.current += 1;
    const { current } = attempt;
    retrying.current = true;
    setConnected(false);
    function finish(next: boolean) {
      if (attempt.current !== current) {
        return;
      }
      retrying.current = false;
      setConnected(next);
    }
    void client.connectUi().then(
      () => finish(client.uiBound),
      () => finish(false),
    );
  }, [client]);

  return { connected, retry };
}
