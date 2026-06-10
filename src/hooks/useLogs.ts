import { useEffect, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";

export function useLogs(client: DaemonClient, serviceName: string | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [offset, setOffset] = useState(0);

  // Fetch initial snapshot + subscribe to new lines
  useEffect(() => {
    if (!serviceName) {
      setLines([]);
      return;
    }

    // Load initial snapshot
    void (async () => {
      try {
        const snapshot = await client.getLogSnapshot(serviceName);
        setLines(snapshot);
      } catch {
        // Snapshot failed — ignore
      }
    })();

    function onLogLines(svc: string, newLines: string[]) {
      if (svc !== serviceName) {
        return;
      }
      setLines((prev) => [...prev, ...newLines]);
    }

    client.on("log.lines", onLogLines);
    return () => {
      client.off("log.lines", onLogLines);
    };
  }, [client, serviceName]);

  function scrollUp() {
    setAutoScroll(false);
    setOffset((o) => o + 1);
  }

  function scrollDown() {
    setOffset((o) => {
      const next = Math.max(0, o - 1);
      if (next === 0) {
        setAutoScroll(true);
      }
      return next;
    });
  }

  function resetScroll() {
    setAutoScroll(true);
    setOffset(0);
  }

  return { lines, autoScroll, offset, scrollUp, scrollDown, resetScroll };
}
