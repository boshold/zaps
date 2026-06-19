import { Box } from "ink";
import type { ReactNode } from "react";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useZaps } from "#src/hooks/useZaps.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { ActionHints } from "./ActionHints.js";
import { ColumnHeaders } from "./ColumnHeaders.js";
import { DashboardServiceList } from "./DashboardServiceList.js";
import { Header } from "./Header.js";
import { HelpBar } from "./HelpBar.js";
import { FullscreenLayout } from "./layout/FullscreenLayout.js";
import { TaskHistorySection } from "./TaskHistorySection.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";

// Wide-layout minimums. The schema allows wideThreshold >= 40, but a split needs
// List + detail + a 1-col gap. Below this total the split cannot fit, so we never
// Enter wide mode under it regardless of config (prevents horizontal overflow).
const LIST_MIN_COLS = 48;
const DETAIL_MIN_COLS = 32;
const MIN_WIDE_COLS = LIST_MIN_COLS + DETAIL_MIN_COLS + 1;

interface DashboardProps {
  /** Pre-sorted in Router (single source of truth shared with the input handler, F8). */
  statuses: ServiceStatus[];
  selectedIndex: number;
  taskHistory: TaskRunRecord[];
  /** Optional sticky top slot — e.g. the disconnect banner when offline. */
  banner?: ReactNode;
}

export function Dashboard({ statuses, selectedIndex, taskHistory, banner }: DashboardProps) {
  const { projectName, configStale, ui } = useZaps();
  const { cols, compact } = useDimensions();
  const selected = statuses[selectedIndex];

  // Wide layout (Q2): on roomy terminals split the body into list + detail pane.
  // Detail pane ~38% clamped to [32, 50] cols; the list keeps the rest (min 48).
  const wide = !compact && cols >= Math.max(ui.wideThreshold, MIN_WIDE_COLS);
  const detailWidth = wide ? Math.min(50, Math.max(DETAIL_MIN_COLS, Math.floor(cols * 0.38))) : 0;
  const listCols = wide ? Math.max(LIST_MIN_COLS, cols - detailWidth - 1) : Math.min(cols, 100);
  const headerWidth = wide ? cols : listCols;

  // Header and footer are fixed chrome; the service list fills the measured body.
  // Recent Tasks lives in the footer so its height is part of the natural chrome
  // Measurement, never a manual row budget (the v1 chromeRows blanking bug).
  const header = (
    <Box flexDirection="column">
      {banner}
      <Header
        projectName={projectName}
        statuses={statuses}
        width={headerWidth}
        compact={compact}
        configStale={configStale}
      />
      {!compact && <ColumnHeaders cols={listCols} />}
    </Box>
  );

  const footer = (
    <Box flexDirection="column">
      {!compact && <TaskHistorySection title="Recent Tasks" history={taskHistory} limit={3} />}
      {!compact && <ActionHints status={selected} />}
      <HelpBar compact={compact} status={selected} />
    </Box>
  );

  return (
    <FullscreenLayout header={header} footer={footer}>
      <DashboardServiceList
        statuses={statuses}
        selectedIndex={selectedIndex}
        cols={listCols}
        detailWidth={detailWidth}
      />
    </FullscreenLayout>
  );
}
