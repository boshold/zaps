import { Box, Text } from "ink";

interface DetailFieldProps {
  label: string;
  value: string;
  color?: string;
}

/** One `label: value` row in the {@link DetailPane}. */
export function DetailField({ label, value, color }: DetailFieldProps) {
  return (
    <Box>
      <Text dimColor={color === undefined} color={color}>{`${label}: `}</Text>
      <Text color={color} wrap="truncate">
        {value}
      </Text>
    </Box>
  );
}
