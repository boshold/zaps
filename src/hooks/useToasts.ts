import type { ReactNode } from "react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** Severity of a toast — drives styling and stickiness (`error` = sticky). */
type ToastLevel = "info" | "success" | "error";

/** One in-app notification (the `40_data_model.md` Toast shape). */
interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  /** Links to a task run so a failure toast can open its output overlay (P05-T05). */
  runId: string | null;
  /** Persist until acknowledged (`dismiss`/`ackAll`) instead of auto-expiring. */
  sticky: boolean;
  createdAt: number;
}

/** What a caller supplies to `notify` — id + createdAt are minted by the hook. */
type ToastInput = Omit<Toast, "id" | "createdAt">;

interface ToastApi {
  toasts: Toast[];
  /** Enqueue a toast; returns its id. info/success auto-dismiss, error stays sticky. */
  notify: (toast: ToastInput) => string;
  /** Remove one toast by id (and cancel its pending auto-dismiss timer). */
  dismiss: (id: string) => void;
  /** Clear all sticky failures (transient toasts expire on their own). */
  ackAll: () => void;
}

/** Default auto-dismiss interval for transient (info/success) toasts. */
const TOAST_TTL_MS = 3000;

const ToastContext = createContext<ToastApi | null>(null);

// Inert fallback for consumers rendered without a provider (isolated component
// Tests). The app root always mounts a real `ToastProvider`.
const NOOP_TOASTS: ToastApi = {
  toasts: [],
  notify: () => "",
  dismiss: () => undefined,
  ackAll: () => undefined,
};

/**
 * Owns the toast queue + auto-dismiss timers and provides it to the tree. The
 * Router calls `notify`/`ackAll`; `DashboardToasts` reads `toasts`. Timers are
 * tracked in a ref and cleared on dismiss/ack/unmount so none leak.
 */
function ToastProvider({
  children,
  ttlMs = TOAST_TTL_MS,
}: {
  children: ReactNode;
  ttlMs?: number;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const ackAll = useCallback(() => {
    setToasts((prev) => {
      for (const toast of prev) {
        if (toast.sticky) {
          clearTimer(toast.id);
        }
      }
      return prev.filter((toast) => !toast.sticky);
    });
  }, [clearTimer]);

  const notify = useCallback(
    (input: ToastInput) => {
      seq.current += 1;
      const id = `toast-${seq.current}`;
      // Errors are always sticky regardless of the caller's flag (AC: error = sticky).
      const sticky = input.sticky || input.level === "error";
      const toast: Toast = { ...input, sticky, id, createdAt: Date.now() };
      setToasts((prev) => [...prev, toast]);
      if (!sticky) {
        const handle = setTimeout(() => {
          timers.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, ttlMs);
        timers.current.set(id, handle);
      }
      return id;
    },
    [ttlMs],
  );

  // Cancel every pending timer on unmount so no callback fires after teardown.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) {
        clearTimeout(handle);
      }
      map.clear();
    };
  }, []);

  const value = useMemo<ToastApi>(
    () => ({ toasts, notify, dismiss, ackAll }),
    [toasts, notify, dismiss, ackAll],
  );

  return createElement(ToastContext.Provider, { value }, children);
}

/** Read the toast API. Returns an inert API when no provider is mounted. */
function useToasts(): ToastApi {
  return useContext(ToastContext) ?? NOOP_TOASTS;
}

export { TOAST_TTL_MS, ToastProvider, useToasts };
export type { Toast, ToastApi, ToastInput, ToastLevel };
