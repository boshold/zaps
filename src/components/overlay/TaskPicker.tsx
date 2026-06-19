import { Box } from "ink";

import type { UiTaskMode } from "#src/config/types.js";
import type { TaskInfo } from "#src/daemon/session.js";
import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";

import { PICKER_ROWS, TaskPickerBody } from "./TaskPickerBody.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const TASK_PICKER_ID = "task-picker";
const PICKER_WIDTH = 60;

interface TaskPickerProps {
  /** Tasks to choose from, frozen at open time. */
  tasks: TaskInfo[];
  /** Task keys with an in-flight run — the per-key duplicate-launch guard (Q12). */
  runningKeys: Set<string>;
  /** Default launch mode for `Enter` (`ui.task.defaultMode`). */
  defaultMode: UiTaskMode;
  /** Launch a task; `mode` is `background` or `pane`. */
  onRun: (key: string, mode: UiTaskMode) => void;
}

/**
 * Centered (absolute) task picker. Positioning is this thin wrapper's only job;
 * all behavior lives in {@link TaskPickerBody} (which stays absolute-free so it is
 * render-testable). Input ownership is gated on `isTop`, so a stacked overlay
 * above it takes over.
 */
function TaskPicker({ tasks, runningKeys, defaultMode, onRun }: TaskPickerProps) {
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();

  const width = Math.min(PICKER_WIDTH, Math.max(24, cols - 4));
  const marginLeft = Math.max(0, Math.floor((cols - width) / 2));
  const marginTop = Math.max(0, Math.floor((rows - PICKER_ROWS) / 3));

  return (
    <Box
      position="absolute"
      marginTop={marginTop}
      marginLeft={marginLeft}
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <TaskPickerBody
        tasks={tasks}
        runningKeys={runningKeys}
        defaultMode={defaultMode}
        isActive={isTop(TASK_PICKER_ID)}
        onClose={pop}
        onRun={onRun}
      />
    </Box>
  );
}

export { TASK_PICKER_ID, TaskPicker };
export type { TaskPickerProps };
