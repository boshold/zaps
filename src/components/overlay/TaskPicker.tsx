import { Box } from "ink";

import type { UiTaskMode } from "#src/config/types.js";
import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import { useZaps } from "#src/hooks/useZaps.js";

import { PICKER_ROWS, TaskPickerBody } from "./TaskPickerBody.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const TASK_PICKER_ID = "task-picker";
const PICKER_WIDTH = 60;

interface TaskPickerProps {
  isRunning: (key: string) => boolean;
  /** Launch a task; `mode` is `background` or `pane`. */
  onRun: (key: string, mode: UiTaskMode) => void;
}

/**
 * Centered (absolute) task picker. Positioning is this thin wrapper's only job;
 * all behavior lives in {@link TaskPickerBody} (which stays absolute-free so it is
 * render-testable). Input ownership is gated on `isTop`, so a stacked overlay
 * above it takes over.
 */
function TaskPicker({ isRunning, onRun }: TaskPickerProps) {
  const { capabilities, tasks, ui } = useZaps();
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
      backgroundColor="default"
      paddingX={1}
    >
      <TaskPickerBody
        tasks={tasks}
        isRunning={isRunning}
        capabilities={capabilities}
        defaultMode={ui.task.defaultMode}
        isActive={isTop(TASK_PICKER_ID)}
        onClose={pop}
        onRun={onRun}
      />
    </Box>
  );
}

export { TASK_PICKER_ID, TaskPicker };
export type { TaskPickerProps };
