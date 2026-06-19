import { useCallback, useMemo, useState } from "react";

import type { Command } from "#src/lib/command-registry.js";
import type { FuzzyMatch } from "#src/lib/fuzzy.js";
import { fuzzyRank } from "#src/lib/fuzzy.js";

interface CommandPaletteState {
  query: string;
  /** Set the query; also resets the selection to the top (best) match. */
  setQuery: (query: string) => void;
  /** Ranked, highlight-annotated matches for the current query. */
  results: FuzzyMatch<Command>[];
  /** The selected index, clamped to the current result set. */
  index: number;
  moveUp: () => void;
  moveDown: () => void;
  /** Run the highlighted command. Returns `true` when one ran, `false` if there was none. */
  runSelected: () => boolean;
}

/**
 * Palette state: the query, the fuzzy-ranked result list (keyed on each
 * command's title for highlight spans), and the clamped selection. It owns no
 * key handling — `CommandPalette` wires `TextInput`/arrow input to these setters
 * so the hook stays render-host agnostic and unit-testable.
 */
function useCommandPalette(commands: Command[]): CommandPaletteState {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const results = useMemo(
    () => fuzzyRank(query, commands, (command) => command.title),
    [query, commands],
  );

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

  const runSelected = useCallback(() => {
    const match = results[clamped];
    if (!match) {
      return false;
    }
    match.item.run();
    return true;
  }, [results, clamped]);

  return { query, setQuery: changeQuery, results, index: clamped, moveUp, moveDown, runSelected };
}

export { useCommandPalette };
export type { CommandPaletteState };
