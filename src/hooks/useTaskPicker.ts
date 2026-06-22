import { useCallback, useMemo, useState } from "react";

import type { TaskInfo } from "#src/daemon/session.js";
import type { FuzzyMatch } from "#src/lib/fuzzy.js";
import { fuzzyRank } from "#src/lib/fuzzy.js";

interface TaskPickerState {
  query: string;
  /** Set the query; also resets the selection to the top (best) match. */
  setQuery: (query: string) => void;
  /** Ranked, highlight-annotated matches for the current query. */
  results: FuzzyMatch<TaskInfo>[];
  /** The selected index, clamped to the current result set. */
  index: number;
  moveUp: () => void;
  moveDown: () => void;
  /** The currently highlighted task, or undefined when there are no results. */
  selected: TaskInfo | undefined;
}

/**
 * Task-picker state: the query, the fuzzy-ranked task list (keyed on each task's
 * name for highlight spans), and the clamped selection. Mirrors
 * {@link useCommandPalette} so the picker and palette behave identically; it owns
 * no key handling, so it stays render-host agnostic and unit-testable.
 */
function useTaskPicker(tasks: TaskInfo[]): TaskPickerState {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const results = useMemo(() => fuzzyRank(query, tasks, (task) => task.name), [query, tasks]);

  // Re-ranking on each keystroke would otherwise leave the cursor on a now-worse
  // Row; snapping to the top keeps the best match under the cursor.
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setIndex(0);
  }, []);

  const clamped = results.length === 0 ? 0 : Math.min(index, results.length - 1);

  const moveUp = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setIndex((i) => Math.min(results.length - 1, i + 1));
  }, [results.length]);

  const selected = results[clamped]?.item;

  return { query, setQuery: changeQuery, results, index: clamped, moveUp, moveDown, selected };
}

export { useTaskPicker };
export type { TaskPickerState };
