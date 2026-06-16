import { useEffect, useState } from "react";

import type { DaemonClient } from "#src/client/daemon-client.js";

// Mirror the daemon's per-service ring buffer so a long-lived TUI can't grow without bound even if the daemon cap changes (F1).
const MAX_CLIENT_LOG_LINES = 10_000;

export function useLogs(client: DaemonClient, serviceName: string | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [offset, setOffset] = useState(0);

  // Fetch initial snapshot + subscribe to new lines.
  useEffect(() => {
    // Reset scroll state on every service change (or clear) so offset/autoScroll never leak across services (F2).
    setOffset(0);
    setAutoScroll(true);

    if (!serviceName) {
      setLines([]);
      return;
    }

    // F7: live lines can arrive while the snapshot is still loading. Buffer them until the snapshot is applied, then concatenate (snapshot → buffered → live). `cancelled` guards against a snapshot that resolves after a service switch overwriting the new service's lines.
    let cancelled = false;
    let snapshotApplied = false;
    let buffered: string[] = [];

    function onLogLines(svc: string, newLines: string[]) {
      if (svc !== serviceName) {
        return;
      }
      if (!snapshotApplied) {
        buffered.push(...newLines);
        return;
      }
      setLines((prev) => [...prev, ...newLines].slice(-MAX_CLIENT_LOG_LINES));
    }
    client.on("log.lines", onLogLines);

    void (async () => {
      try {
        const snapshot = await client.getLogSnapshot(serviceName);
        if (!cancelled) {
          setLines([...snapshot, ...buffered].slice(-MAX_CLIENT_LOG_LINES));
        }
      } catch {
        // Snapshot failed — fall back to whatever live lines we buffered.
        if (!cancelled) {
          setLines(buffered.slice(-MAX_CLIENT_LOG_LINES));
        }
      } finally {
        snapshotApplied = true;
        buffered = [];
      }
    })();

    return () => {
      cancelled = true;
      client.off("log.lines", onLogLines);
    };
  }, [client, serviceName]);

  // Re-clamp the offset when the line count drops (e.g. the cap trims lines) so the visible slice never points past the oldest line into blank space (F2).
  useEffect(() => {
    setOffset((o) => Math.min(o, Math.max(0, lines.length - 1)));
  }, [lines.length]);

  function scrollUp() {
    setAutoScroll(false);
    // Clamp so the oldest line stays visible — never scroll into blank space.
    setOffset((o) => Math.min(o + 1, Math.max(0, lines.length - 1)));
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

  return { lines, autoScroll, offset, scrollUp, scrollDown };
}
