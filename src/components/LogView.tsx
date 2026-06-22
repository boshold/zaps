import { Box, Text, useInput } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";

import { Header } from "./Header.js";
import { FullscreenLayout } from "./layout/FullscreenLayout.js";
import { LogViewBody } from "./LogViewBody.js";
import { useIcons } from "./theme/IconTheme.js";

export interface LogViewProps {
  serviceName: string;
  lines: string[];
  autoScroll: boolean;
  offset: number;
  /** Leave the full-screen log view (Esc). */
  onBack?: () => void;
  /** Scroll one line towards older output. */
  scrollUp?: () => void;
  /** Scroll one line towards newer output (re-enables follow at the tail). */
  scrollDown?: () => void;
  /** Whether the Router has routed input to the log view (false → inert). */
  inputActive?: boolean;
}

export function LogView({
  serviceName,
  lines,
  autoScroll,
  offset,
  onBack,
  scrollUp,
  scrollDown,
  inputActive = false,
}: LogViewProps) {
  const { cols, compact } = useDimensions();
  const { icon } = useIcons();

  // The log view owns its own input (gated by the Router via `inputActive`).
  useInput(
    (input, key) => {
      if (key.escape) {
        onBack?.();
      }
      if (key.upArrow || input === "k") {
        scrollUp?.();
      }
      if (key.downArrow || input === "j") {
        scrollDown?.();
      }
    },
    { isActive: inputActive },
  );
  const up = icon("overflowUp");
  const down = icon("overflowDown");

  const header = <Header projectName={serviceName} statuses={[]} width={cols} compact={compact} />;
  const footer = (
    <Box>
      <Text dimColor>{`[j/k/${up}/${down}] scroll [esc] back `}</Text>
      {/* Autoscroll state: live tails the newest lines; paused resumes by
          scrolling back down to the bottom (down/j), which re-enables follow. */}
      <Text color={autoScroll ? "green" : "yellow"}>
        {autoScroll ? `${icon("live")} live` : `${icon("paused")} paused (${down} to follow)`}
      </Text>
    </Box>
  );

  return (
    <FullscreenLayout header={header} footer={footer}>
      <LogViewBody lines={lines} autoScroll={autoScroll} offset={offset} />
    </FullscreenLayout>
  );
}
