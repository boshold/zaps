import { Box, Text } from "ink";

export function ColumnHeaders() {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {"    "}
        {"NAME".padEnd(16)}
        {"STATUS".padEnd(10)}
        {"PORTS".padEnd(12)}
        {"URL".padEnd(24)}
        ACTIONS
      </Text>
    </Box>
  );
}
