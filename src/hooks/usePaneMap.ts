import { useEffect, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";
import type { SessionSnapshot } from "#src/daemon/session.js";

type PaneMap = Record<string, string>;

/**
 * Keep the pane map live. The TUI receives a `paneMap` snapshot at attach, but
 * lazy panes (non-autostart services) are created/destroyed afterwards via
 * reflow — without this, `z` (zoom) and `E` (edit-capture) resolve a missing or
 * stale pane for any optional service started after launch. Mirrors
 * `useServices`: seed from the snapshot, then track `session.paneMap` events and
 * refresh wholesale on config reload.
 */
export function usePaneMap(client: DaemonClient, initial: PaneMap): PaneMap {
  const [paneMap, setPaneMap] = useState<PaneMap>(initial);

  useEffect(() => {
    function onPaneMap(next: PaneMap) {
      setPaneMap(next);
    }
    function onReload(snapshot: SessionSnapshot) {
      setPaneMap(snapshot.paneMap);
    }
    client.on("session.paneMap", onPaneMap);
    client.on("session.configReloaded", onReload);
    return () => {
      client.off("session.paneMap", onPaneMap);
      client.off("session.configReloaded", onReload);
    };
  }, [client]);

  return paneMap;
}
