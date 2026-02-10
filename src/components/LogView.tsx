import { Box, Text } from "ink";

import { Header } from "./Header.js";

export interface LogViewProps {
  serviceName: string;
  lines: string[];
  autoScroll: boolean;
  offset: number;
}

export function LogView({ serviceName, lines, autoScroll, offset }: LogViewProps) {
  const termHeight = process.stdout.rows ?? 24;
  const visibleLines = termHeight - 4; // Header + help bar + padding

  const displayLines = autoScroll
    ? lines.slice(-visibleLines)
    : lines.slice(-(visibleLines + offset), offset > 0 ? -offset : lines.length);

  return (
    <Box flexDirection="column" padding={1}>
      <Header projectName={serviceName} />
      <Box flexDirection="column" marginTop={1}>
        {displayLines.map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key -- Log lines have no stable ID
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[↑/↓] scroll [esc] back</Text>
      </Box>
    </Box>
  );
}
