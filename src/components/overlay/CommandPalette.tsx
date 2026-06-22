import { Box } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import type { Command } from "#src/lib/command-registry.js";

import { CommandPaletteBody, PALETTE_ROWS } from "./CommandPaletteBody.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const COMMAND_PALETTE_ID = "command-palette";
const PALETTE_WIDTH = 60;

interface CommandPaletteProps {
  /** The flattened registry built at open time (selection/tasks frozen while open). */
  commands: Command[];
}

/**
 * Centered (absolute) command palette. Positioning is this thin wrapper's only
 * job; all behavior lives in {@link CommandPaletteBody} (which stays absolute-free
 * so it is render-testable). Input ownership is gated on `isTop`, so a stacked
 * overlay above it takes over.
 */
function CommandPalette({ commands }: CommandPaletteProps) {
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();

  const width = Math.min(PALETTE_WIDTH, Math.max(24, cols - 4));
  const marginLeft = Math.max(0, Math.floor((cols - width) / 2));
  const marginTop = Math.max(0, Math.floor((rows - PALETTE_ROWS) / 3));

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
      <CommandPaletteBody commands={commands} isActive={isTop(COMMAND_PALETTE_ID)} onClose={pop} />
    </Box>
  );
}

export { COMMAND_PALETTE_ID, CommandPalette };
export type { CommandPaletteProps };
