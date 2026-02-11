import { Box, Text } from "ink";

export function ErrorSubRow({ error }: { error: string }) {
  return (
    <Box marginLeft={2}>
      <Text dimColor>│ Error: {error}</Text>
    </Box>
  );
}
