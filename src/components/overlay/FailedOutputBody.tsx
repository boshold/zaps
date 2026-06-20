import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { ScrollableList } from "#src/components/layout/ScrollableList.js";
import { useIcons } from "#src/components/theme/IconTheme.js";

/** Fetch lifecycle for a failed run's retained output. */
type FailedOutputState = "loading" | "ready" | "not_found" | "error";

interface FailedOutputBodyProps {
  taskName: string;
  state: FailedOutputState;
  lines: string[];
  /** Bottom-anchored scroll position (index of the line kept in view). */
  selectedIndex: number;
  /** Line budget for the scrollable output region. */
  maxHeight: number;
  /** Whether tmux `display-popup` escalation is offered in the hint row. */
  canEscalate: boolean;
}

// Single-line status shown instead of the list while loading / evicted / errored
// / empty. Lowercase + a plain return so it is not treated as its own component.
function statusMessage(state: FailedOutputState, lineCount: number): string | null {
  if (state === "loading") {
    return "Loading output…";
  }
  if (state === "not_found") {
    return "Output no longer available (evicted).";
  }
  if (state === "error") {
    return "Could not load output.";
  }
  if (state === "ready" && lineCount === 0) {
    return "(no output captured)";
  }
  return null;
}

/**
 * The absolute-free body of {@link FailedOutputOverlay} — title, the windowed
 * output (or a status line for loading/evicted/error/empty), and the key hints.
 * Kept positioning-free so it stays render-testable (ink-testing-library cannot
 * capture absolute boxes).
 */
export function FailedOutputBody({
  taskName,
  state,
  lines,
  selectedIndex,
  maxHeight,
  canEscalate,
}: FailedOutputBodyProps) {
  const { icon } = useIcons();
  const message = statusMessage(state, lines.length);
  const content: ReactNode =
    message === null ? (
      <ScrollableList
        items={lines}
        selectedIndex={selectedIndex}
        maxHeight={maxHeight}
        renderItem={(line, i) => (
          <Text key={i} wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        )}
      />
    ) : (
      <Text dimColor>{message}</Text>
    );

  return (
    <Box flexDirection="column">
      <Text bold color="red">
        {icon("taskError")} Failed: {taskName}
      </Text>
      <Box marginTop={1} paddingX={1}>
        {content}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[↑↓/jk] scroll{canEscalate ? " [p] popup" : ""} [esc] close</Text>
      </Box>
    </Box>
  );
}

export type { FailedOutputBodyProps, FailedOutputState };
