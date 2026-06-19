import type { ServiceStatus } from "#src/lib/service/types.js";

import { useViewportSize } from "./layout/ViewportContext.js";
import { ServiceList } from "./ServiceList.js";

interface DashboardServiceListProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  cols: number;
}

/**
 * The dashboard service list, windowed to the measured body height. Reads the
 * viewport from `FullscreenLayout` instead of any `chromeRows` arithmetic — the
 * height is whatever the flexbox layout leaves between the fixed header and
 * footer, so the list can never overflow and blank the pane (the v1 bug).
 */
export function DashboardServiceList({ statuses, selectedIndex, cols }: DashboardServiceListProps) {
  const { height } = useViewportSize();
  return (
    <ServiceList statuses={statuses} selectedIndex={selectedIndex} maxRows={height} cols={cols} />
  );
}
