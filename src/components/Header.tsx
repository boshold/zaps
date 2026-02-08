import { Box, Text } from "ink";

export function Header({ projectName }: { projectName: string }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          ⚡ zaps:{" "}
        </Text>
        <Text bold>{projectName}</Text>
      </Box>
      <Text dimColor>─────────────────────────────────</Text>
    </Box>
  );
}
