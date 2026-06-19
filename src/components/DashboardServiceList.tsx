import { Box } from "ink";

import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { DetailPane } from "./dashboard/DetailPane.js";
import { useViewportSize } from "./layout/ViewportContext.js";
import { ServiceList } from "./ServiceList.js";
import { EmptyState } from "./states/EmptyState.js";
import { EMPTY_STATE_MESSAGES } from "./states/messages.js";
import { useIcons } from "./theme/IconTheme.js";

interface DashboardServiceListProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
  cols: number;
  /** Width of the right-hand detail pane; 0 hides it (narrow layout). */
  detailWidth?: number;
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
export function DashboardServiceList({
  statuses,
  selectedIndex,
  cols,
  detailWidth = 0,
}: DashboardServiceListProps) {
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

  const list = (
    <ServiceList statuses={statuses} selectedIndex={selectedIndex} maxRows={height} cols={cols} />
  );

  // Wide layout: list on the left, selected-service detail on the right.
  if (detailWidth > 0) {
    return (
      <Box flexDirection="row">
        <Box width={cols} flexShrink={0} flexDirection="column">
          {list}
        </Box>
        <DetailPane status={statuses[selectedIndex]} width={detailWidth} />
      </Box>
    );
  }

  return list;
}
