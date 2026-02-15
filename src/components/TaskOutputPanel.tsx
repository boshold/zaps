import { Box, Text } from "ink";

// eslint-disable-next-line no-control-regex -- Matching ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function sanitizeLine(line: string): string {
  return line.replace(ANSI_RE, "").replace(/[^\x20-\x7E]/g, " ");
}

function truncateLine(line: string, maxWidth: number): string {
  const clean = sanitizeLine(line);
  if (clean.length <= maxWidth) {
    return clean;
  }
  return clean.slice(0, maxWidth);
}

interface TaskOutputPanelProps {
  lines: string[];
  visibleLines: number;
  width: number;
}

export function TaskOutputPanel({ lines, visibleLines, width }: TaskOutputPanelProps) {
  return (
    <Box flexDirection="column" width="60%" borderStyle="single" borderColor="gray" paddingX={1}>
      {lines.slice(-visibleLines).map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key -- Log lines have no stable key
        <Text key={i}>{truncateLine(line, width)}</Text>
      ))}
    </Box>
  );
}
