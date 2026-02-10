import { capturePane } from "#src/lib/tmux.js";
import { useEffect, useRef, useState } from "react";

export function useLogs(paneTarget: string | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const fetchingRef = useRef(false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!paneTarget) {
      return;
    }
    const id = setInterval(() => {
      if (fetchingRef.current) {
        return;
      }
      fetchingRef.current = true;
      // eslint-disable-next-line no-void -- Fire-and-forget promise
      void (async () => {
        try {
          const output = await capturePane(paneTarget, 200);
          setLines(output.split("\n"));
        } finally {
          fetchingRef.current = false;
        }
      })();
    }, 500);
    return () => {
      clearInterval(id);
    };
  }, [paneTarget]);

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
