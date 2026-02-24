import { Box, Text } from "ink";

export function ColumnHeaders() {
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
