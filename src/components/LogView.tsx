import { Box, Text } from "ink";

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
}

export function LogView({ serviceName, lines, autoScroll, offset }: LogViewProps) {
  const { cols, compact } = useDimensions();
  const { icon } = useIcons();
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
