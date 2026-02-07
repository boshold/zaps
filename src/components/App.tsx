import { Box, Text } from "ink";

export function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        ⚡ zaps
      </Text>
      <Text dimColor>Terminal session manager</Text>
    </Box>
  );
}
