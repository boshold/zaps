import { Box, Text, useInput } from "ink";
import type { RefObject } from "react";

import { helpKeymap } from "#src/components/hintText.js";
import type { KeymapGroup } from "#src/components/hintText.js";
import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";
import { useZaps } from "#src/hooks/useZaps.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const HELP_OVERLAY_ID = "help";
const HELP_WIDTH = 60;

// Mirrors the `0.1.0` baked into `cli.tsx --version`; bump both together.
const VERSION = "0.1.0";

/** One keymap group (own JSX tree → shallow depth); title plus aligned key rows. */
function renderGroup(group: KeymapGroup) {
  return (
    <Box key={group.title} flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        {group.title}
      </Text>
      {group.rows.map(([keys, description]) => (
        <Text key={keys}>
          <Text color="green">{keys.padEnd(14)}</Text>
          {description}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Centered (absolute) help overlay: the full keymap reference + version. Owns its
 * own input gated on `isTop` — `?` toggles it closed; Esc closes via `OverlayHost`
 * (not bound here, so no double-pop).
 */
function HelpOverlay({
  selectedName,
  busyServices,
}: {
  selectedName?: string;
  busyServices?: RefObject<Set<string>>;
}) {
  const { capabilities, statuses } = useZaps();
  const status = statuses.find(({ name }) => name === selectedName);
  const keymap = helpKeymap(capabilities, status, status && busyServices?.current.has(status.name));
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();

  useInput(
    (input) => {
      if (input === "?") {
        pop();
      }
    },
    { isActive: isTop(HELP_OVERLAY_ID) },
  );

  const width = Math.min(HELP_WIDTH, Math.max(24, cols - 4));
  const marginLeft = Math.max(0, Math.floor((cols - width) / 2));
  const marginTop = Math.max(0, Math.floor((rows - keymap.length * 6) / 4));

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
      <Text bold>{`zaps — help  (v${VERSION})`}</Text>
      {keymap.map((group) => renderGroup(group))}
      <Box marginTop={1}>
        <Text dimColor>? or esc to close</Text>
      </Box>
    </Box>
  );
}

export { HELP_OVERLAY_ID, HelpOverlay };
