import { Box, Text } from "ink";

export function ColumnHeaders() {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {"    "}
        {"NAME".padEnd(18)}
        {"STATUS".padEnd(14)}
        {"PORTS".padEnd(20)}
        URL
      </Text>
    </Box>
  );
}
