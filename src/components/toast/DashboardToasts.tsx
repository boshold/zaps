import { useToasts } from "#src/hooks/useToasts.js";

import { ToastList } from "./ToastList.js";

/** How many recent toasts to show at once (older ones scroll off the top). */
const MAX_VISIBLE = 3;

/**
 * In-flow notification strip for the dashboard footer. Replaces the old
 * `position="absolute"` ToastHost: reserved (laid-out) rows can never overprint
 * the service list the way the bottom-anchored float did on short panes. Renders
 * nothing when the queue is empty, so it costs no rows until a toast arrives.
 */
export function DashboardToasts() {
  const { toasts } = useToasts();

  if (toasts.length === 0) {
    return null;
  }

  const visible = toasts.slice(-MAX_VISIBLE);
  const stickyTotal = toasts.filter((toast) => toast.sticky).length;

  return <ToastList toasts={visible} stickyTotal={stickyTotal} />;
}
