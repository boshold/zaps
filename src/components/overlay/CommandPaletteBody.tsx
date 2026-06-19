import { Box, Text, useInput } from "ink";

import { TextInput } from "#src/components/input/index.js";
import { ScrollableList } from "#src/components/layout/ScrollableList.js";
import { useIcons } from "#src/components/theme/IconTheme.js";
import { useCommandPalette } from "#src/hooks/useCommandPalette.js";
import type { Command } from "#src/lib/command-registry.js";
import type { FuzzyMatch } from "#src/lib/fuzzy.js";

import { CommandRow } from "./CommandRow.js";

const PALETTE_ROWS = 10;

/** Render one ranked match as a highlighted row (module-scope: captures nothing). */
function renderRow(match: FuzzyMatch<Command>, _index: number, selected: boolean) {
  return (
    <CommandRow
      title={match.item.title}
      indexes={match.indexes}
      hint={match.item.hint}
      selected={selected}
    />
  );
}

interface CommandPaletteBodyProps {
  /** The flattened registry, frozen at open time (selection/tasks don't change while open). */
  commands: Command[];
  /** Whether this palette owns input (gated on `isTop` by the wrapper). */
  isActive: boolean;
  /** Close the palette — the wrapper passes the overlay `pop`. */
  onClose: () => void;
}

/**
 * The palette's content — query field, ranked result list, footer. Kept free of
 * absolute positioning so it is render-testable; `CommandPalette` wraps it in the
 * centered overlay box. `TextInput` owns the query and Enter (→ run selected);
 * arrow keys move the selection. It deliberately does NOT bind Esc — `OverlayHost`
 * owns Esc→pop, so one press closes it once (no double-pop).
 */
function CommandPaletteBody({ commands, isActive, onClose }: CommandPaletteBodyProps) {
  const { icon } = useIcons();
  const { query, setQuery, results, index, moveUp, moveDown, runSelected } =
    useCommandPalette(commands);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        moveUp();
      } else if (key.downArrow) {
        moveDown();
      }
    },
    { isActive },
  );

  function handleSubmit() {
    if (runSelected()) {
      onClose();
    }
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{`${icon("selection")} `}</Text>
        <TextInput
          value={query}
          onChange={setQuery}
          onSubmit={handleSubmit}
          placeholder="Type a command…"
          isActive={isActive}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {results.length === 0 ? (
          <Text dimColor>No matching commands</Text>
        ) : (
          <ScrollableList
            items={results}
            selectedIndex={index}
            maxHeight={PALETTE_ROWS}
            renderItem={renderRow}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>up/down: move · enter: run · esc: close</Text>
      </Box>
    </Box>
  );
}

export { CommandPaletteBody, PALETTE_ROWS };
export type { CommandPaletteBodyProps };
