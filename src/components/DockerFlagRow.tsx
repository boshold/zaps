import { Box, Text } from "ink";

interface DockerFlagRowProps {
  label: string;
  description: string;
  active: boolean;
  checked: boolean;
}

export function DockerFlagRow({ label, description, active, checked }: DockerFlagRowProps) {
  return (
    <Box>
      <Text>
        {active ? "> " : "  "}
        {checked ? "[x]" : "[ ]"} {label.padEnd(18)}
      </Text>
      <Text dimColor>{description}</Text>
    </Box>
  );
}
