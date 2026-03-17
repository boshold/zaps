import { Box, Text } from "ink";

export function ColumnHeaders({ cols }: { cols: number }) {
  if (cols >= 80) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          {"    "}
          {"NAME".padEnd(24)}
          {"STATUS".padEnd(10)}
          {"PORTS".padEnd(24)}
          {"URL".padEnd(38)}
        </Text>
      </Box>
    );
  }

  if (cols >= 50) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          {"    "}
          {"NAME".padEnd(20)}
          {"STATUS".padEnd(10)}
          PORTS
        </Text>
      </Box>
    );
  }

  if (cols >= 30) {
    const nameWidth = Math.max(4, cols - 4 - 8);
    return (
      <Box marginTop={1}>
        <Text dimColor>
          {"    "}
          {"NAME".padEnd(nameWidth)}
          STATUS
        </Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text dimColor>{"    NAME"}</Text>
    </Box>
  );
}
