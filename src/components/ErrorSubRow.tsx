import { Box, Text } from "ink";

import { useIcons } from "./theme/IconTheme.js";

export function ErrorSubRow({ error }: { error: string }) {
  const { icon } = useIcons();
  return (
    <Box marginLeft={2}>
      <Text dimColor>
        {icon("treeBranch")} Error: {error}
      </Text>
    </Box>
  );
}
