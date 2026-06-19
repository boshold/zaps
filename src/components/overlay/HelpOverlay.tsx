import { Box, Text, useInput } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const HELP_OVERLAY_ID = "help";
const HELP_WIDTH = 60;

// Mirrors the `0.1.0` baked into `cli.tsx --version`; bump both together.
const VERSION = "0.1.0";

interface KeymapGroup {
  title: string;
  /** `[keys, description]` rows — the documented keymap from `50_api.md`. */
  rows: [string, string][];
}

// Single in-app source for the keymap reference (mirrors 50_api.md "Command API").
const KEYMAP: KeymapGroup[] = [
  {
    title: "Global",
    rows: [
      ["Ctrl-K / :", "Command palette"],
      ["?", "Help (this)"],
      ["q / Ctrl-C", "Detach (services keep running)"],
      ["Ctrl-D", "Shut down session"],
      ["Esc", "Close overlay / leave view"],
    ],
  },
  {
    title: "Dashboard",
    rows: [
      ["↑↓ / k j", "Move selection"],
      ["r", "Restart selected"],
      ["s", "Start/stop selected"],
      ["a", "Restart all"],
      ["c", "Reload config"],
      ["l", "Open logs"],
      ["o", "Open URL"],
      ["R", "Docker rebuild"],
      ["z / Z", "Zoom pane / TUI pane"],
      ["E", "Edit-capture pane"],
      ["t", "Task picker"],
    ],
  },
  {
    title: "Palette / picker",
    rows: [
      ["type", "Fuzzy filter"],
      ["↑↓", "Move"],
      ["Enter", "Run / confirm"],
      ["Esc", "Close"],
    ],
  },
];

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
function HelpOverlay() {
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
  const marginTop = Math.max(0, Math.floor((rows - KEYMAP.length * 6) / 4));

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
      <Text bold>{`zaps — help  (v${VERSION})`}</Text>
      {KEYMAP.map((group) => renderGroup(group))}
      <Box marginTop={1}>
        <Text dimColor>? or esc to close</Text>
      </Box>
    </Box>
  );
}

export { HELP_OVERLAY_ID, HelpOverlay, KEYMAP };
