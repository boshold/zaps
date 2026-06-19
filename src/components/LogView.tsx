import { Box, Text } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";

import { Header } from "./Header.js";
import { FullscreenLayout } from "./layout/FullscreenLayout.js";
import { LogViewBody } from "./LogViewBody.js";

export interface LogViewProps {
  serviceName: string;
  lines: string[];
  autoScroll: boolean;
  offset: number;
}

export function LogView({ serviceName, lines, autoScroll, offset }: LogViewProps) {
  const { cols, compact } = useDimensions();

  const header = <Header projectName={serviceName} statuses={[]} width={cols} compact={compact} />;
  const footer = (
    <Box>
      <Text dimColor>[j/k/↑/↓] scroll [esc] back </Text>
      {/* Autoscroll state: live tails the newest lines; paused resumes by
          scrolling back down to the bottom (↓/j), which re-enables follow. */}
      <Text color={autoScroll ? "green" : "yellow"}>
        {autoScroll ? "● live" : "⏸ paused (↓ to follow)"}
      </Text>
    </Box>
  );

  return (
    <FullscreenLayout header={header} footer={footer}>
      <LogViewBody lines={lines} autoScroll={autoScroll} offset={offset} />
    </FullscreenLayout>
  );
}
