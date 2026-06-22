import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { TextInput } from "#src/components/input/index.js";
import { ScrollableList } from "#src/components/layout/ScrollableList.js";
import { EMPTY_STATE_MESSAGES, emptyFilterMessage } from "#src/components/states/messages.js";
import { useIcons } from "#src/components/theme/IconTheme.js";
import type { UiTaskMode } from "#src/config/types.js";
import type { TaskInfo } from "#src/daemon/session.js";
import { useTaskPicker } from "#src/hooks/useTaskPicker.js";
import type { FuzzyMatch } from "#src/lib/fuzzy.js";

import { CommandRow } from "./CommandRow.js";

const PICKER_ROWS = 10;

/** Render one ranked task as a highlighted row (module-scope: captures nothing). */
function renderRow(match: FuzzyMatch<TaskInfo>, _index: number, selected: boolean) {
  return (
    <CommandRow
      title={match.item.name}
      indexes={match.indexes}
      hint={match.item.shortcut}
      selected={selected}
    />
  );
}

interface TaskPickerBodyProps {
  /** Tasks to choose from, frozen at open time. */
  tasks: TaskInfo[];
  /** Task keys with an in-flight run — the per-key duplicate-launch guard (Q12). */
  runningKeys: Set<string>;
  /** Default launch mode for `Enter` (`ui.task.defaultMode`). */
  defaultMode: UiTaskMode;
  /** Whether this picker owns input (gated on `isTop` by the wrapper). */
  isActive: boolean;
  /** Close the picker — the wrapper passes the overlay `pop`. */
  onClose: () => void;
  /** Launch a task; `mode` is `background` or `pane`. */
  onRun: (key: string, mode: UiTaskMode) => void;
}

/**
 * The picker's content — query field, ranked task list, footer. Kept free of
 * absolute positioning so it is render-testable; `TaskPicker` wraps it in the
 * centered overlay box. `TextInput` owns the query + Enter (→ run in the default
 * mode); `Tab` runs the selection live in a tmux pane. It deliberately does NOT
 * bind Esc — `OverlayHost` owns Esc→pop, so one press closes it once.
 */
function TaskPickerBody({
  tasks,
  runningKeys,
  defaultMode,
  isActive,
  onClose,
  onRun,
}: TaskPickerBodyProps) {
  const { icon } = useIcons();
  const { query, setQuery, results, index, moveUp, moveDown, selected } = useTaskPicker(tasks);
  const [notice, setNotice] = useState<string | null>(null);

  function changeQuery(next: string) {
    setNotice(null);
    setQuery(next);
  }

  function launch(mode: UiTaskMode) {
    if (!selected) {
      return;
    }
    // Q12 duplicate guard: surface "already running" rather than double-starting.
    if (runningKeys.has(selected.key)) {
      setNotice(`${selected.name} is already running`);
      return;
    }
    // Close first, then run, mirroring the palette (run-in-pane could push UI later).
    onClose();
    onRun(selected.key, mode);
  }

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        moveUp();
        setNotice(null);
      } else if (key.downArrow) {
        moveDown();
        setNotice(null);
      } else if (key.tab) {
        launch("pane");
      }
    },
    { isActive },
  );

  // Distinct empty states: no tasks at all vs. a query that matches nothing.
  function renderResults() {
    if (tasks.length === 0) {
      return <Text dimColor>{EMPTY_STATE_MESSAGES.noTasks}</Text>;
    }
    if (results.length === 0) {
      return <Text dimColor>{emptyFilterMessage(query)}</Text>;
    }
    return (
      <ScrollableList
        items={results}
        selectedIndex={index}
        maxHeight={PICKER_ROWS}
        renderItem={renderRow}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{`${icon("selection")} `}</Text>
        <TextInput
          value={query}
          onChange={changeQuery}
          onSubmit={() => launch(defaultMode)}
          placeholder="Type to filter tasks…"
          isActive={isActive}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {renderResults()}
      </Box>
      {notice ? (
        <Box marginTop={1}>
          <Text color="yellow">{notice}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>up/down: move · enter: run · tab: run in pane · esc: close</Text>
      </Box>
    </Box>
  );
}

export { TaskPickerBody, PICKER_ROWS };
export type { TaskPickerBodyProps };
