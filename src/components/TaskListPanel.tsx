import { Box, Text } from "ink";

import type { TaskInfo } from "#src/daemon/session.js";
import type { TaskShortcut } from "#src/lib/taskShortcuts.js";

import { TaskHistorySection } from "./TaskHistorySection.js";
import { TaskRow } from "./TaskRow.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { useIcons } from "./theme/IconTheme.js";

interface TaskListPanelProps {
  tasks: TaskInfo[];
  selectedIndex: number;
  taskResults: Record<string, "success" | "error">;
  runningTask: string | null;
  taskShortcuts: TaskShortcut[];
  taskHistory: TaskRunRecord[];
  maxRows?: number;
  compact?: boolean;
  width: number;
  showHistory?: boolean;
}

function computeScrollOffset(selectedIndex: number, total: number, maxRows: number): number {
  if (total <= maxRows) {
    return 0;
  }
  const half = Math.floor(maxRows / 2);
  return Math.max(0, Math.min(selectedIndex - half, total - maxRows));
}

export function TaskListPanel({
  tasks,
  selectedIndex,
  taskResults,
  runningTask,
  taskShortcuts,
  taskHistory,
  maxRows,
  compact,
  width,
  showHistory = true,
}: TaskListPanelProps) {
  const { icon } = useIcons();
  const shortcutMap = new Map(taskShortcuts.map((s) => [s.name, s.shortcut]));

  // Help text takes 1 row, history takes 2+ rows
  const helpRows = compact ? 0 : 1;
  const historyRows =
    !showHistory || compact || taskHistory.length === 0 ? 0 : Math.min(taskHistory.length, 10) + 2;
  const taskMaxRows =
    maxRows !== undefined ? Math.max(1, maxRows - helpRows - historyRows) : undefined;

  const total = tasks.length;
  const needsScroll = taskMaxRows !== undefined && total > taskMaxRows;
  const offset = needsScroll ? computeScrollOffset(selectedIndex, total, taskMaxRows) : 0;

  // Adjust for scroll indicators
  const hasAbove = offset > 0;
  const hasBelow = needsScroll && offset + taskMaxRows < total;
  const indicatorRows = (hasAbove ? 1 : 0) + (hasBelow ? 1 : 0);
  const visibleCount = needsScroll ? Math.max(1, taskMaxRows - indicatorRows) : total;
  const adjOffset = needsScroll ? computeScrollOffset(selectedIndex, total, visibleCount) : 0;
  const visible = tasks.slice(adjOffset, adjOffset + visibleCount);
  const above = adjOffset;
  const below = total - adjOffset - visibleCount;

  return (
    <Box flexDirection="column" width={width} overflow="hidden" marginRight={compact ? 0 : 1}>
      <Box flexDirection="column" flexGrow={1}>
        {above > 0 && (
          <Text dimColor>
            {"  "}
            {icon("overflowUp")} {above} more
          </Text>
        )}
        {visible.map((task, i) => (
          <TaskRow
            key={task.key}
            task={task}
            isSelected={i + adjOffset === selectedIndex}
            result={taskResults[task.key]}
            isRunning={runningTask === task.key}
            shortcut={shortcutMap.get(task.name)}
            maxWidth={width}
          />
        ))}
        {below > 0 && (
          <Text dimColor>
            {"  "}
            {icon("overflowDown")} {below} more
          </Text>
        )}
      </Box>
      {showHistory && !compact && (
        <TaskHistorySection title="History" history={taskHistory} limit={10} maxWidth={width} />
      )}
      {!compact && (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate">
            {`[j/k/${icon("overflowUp")}/${icon("overflowDown")}] select [enter] run [key] shortcut [esc] back`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
