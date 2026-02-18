import { Box, Text } from "ink";

// eslint-disable-next-line no-control-regex -- Matching ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function sanitizeLine(line: string): string {
  return line.replace(ANSI_RE, "").replace(/[^\x20-\x7E]/g, " ");
}

interface TaskOutputPanelProps {
  lines: string[];
  visibleLines: number;
}

export function TaskOutputPanel({ lines, visibleLines }: TaskOutputPanelProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
    >
      {lines.slice(-visibleLines).map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key -- Log lines have no stable key
        <Text key={i} wrap="truncate">
          {sanitizeLine(line)}
        </Text>
      ))}
    </Box>
  );
}
