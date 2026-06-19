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

interface DashboardProps {
  /** Pre-sorted in Router (single source of truth shared with the input handler, F8). */
  statuses: ServiceStatus[];
  selectedIndex: number;
  taskHistory: TaskRunRecord[];
  /** Optional sticky top slot — e.g. the disconnect banner when offline. */
  banner?: ReactNode;
}

export function Dashboard({ statuses, selectedIndex, taskHistory, banner }: DashboardProps) {
  const { projectName, configStale } = useZaps();
  const { cols, compact } = useDimensions();
  const width = Math.min(cols, 100);
  const selected = statuses[selectedIndex];

  // Header and footer are fixed chrome; the service list fills the measured body.
  // Recent Tasks lives in the footer so its height is part of the natural chrome
  // Measurement, never a manual row budget (the v1 chromeRows blanking bug).
  const header = (
    <Box flexDirection="column">
      {banner}
      <Header
        projectName={projectName}
        statuses={statuses}
        width={width}
        compact={compact}
        configStale={configStale}
      />
      {!compact && <ColumnHeaders cols={width} />}
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
      <DashboardServiceList statuses={statuses} selectedIndex={selectedIndex} cols={width} />
    </FullscreenLayout>
  );
}
