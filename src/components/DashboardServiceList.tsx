import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { useViewportSize } from "./layout/ViewportContext.js";
import { ServiceList } from "./ServiceList.js";
import { EmptyState } from "./states/EmptyState.js";
import { EMPTY_STATE_MESSAGES } from "./states/messages.js";
import { useIcons } from "./theme/IconTheme.js";

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
 *
 * When there are no statuses to show it renders a centered placeholder instead
 * of a blank body: "no services configured" when the config has none, otherwise
 * "starting services" (attached, nothing reported yet).
 */
export function DashboardServiceList({ statuses, selectedIndex, cols }: DashboardServiceListProps) {
  const { height } = useViewportSize();
  const { servicesMeta } = useZaps();
  const { icon } = useIcons();

  if (statuses.length === 0) {
    return (
      <EmptyState
        message={
          servicesMeta.length === 0
            ? EMPTY_STATE_MESSAGES.noServices
            : `${EMPTY_STATE_MESSAGES.loadingServices}${icon("ellipsis")}`
        }
      />
    );
  }

  return (
    <ServiceList statuses={statuses} selectedIndex={selectedIndex} maxRows={height} cols={cols} />
  );
}
