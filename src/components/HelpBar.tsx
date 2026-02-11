import { Box, Text } from "ink";

export function HelpBar() {
  return (
    <Box marginTop={1}>
      <Text dimColor>[r]estart [s]top/start [l]ogs [o]pen | [t]asks [a]ll restart [q]uit</Text>
    </Box>
  );
}
