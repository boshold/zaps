import { Box, Text } from "ink";

import type { ServiceState } from "#src/lib/service/types.js";

interface StartServicesEntry {
  name: string;
  state: ServiceState;
  required: boolean;
}

interface StartServicesBodyProps {
  taskName: string;
  services: StartServicesEntry[];
}

/**
 * Positioning-free body of {@link StartServicesOverlay}, kept render-testable.
 */
export function StartServicesBody({ taskName, services }: StartServicesBodyProps) {
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Start services for {taskName}?
      </Text>
      <Box marginTop={1} flexDirection="column" paddingX={1}>
        {services.map((service) => (
          <Text key={service.name} wrap="truncate-end">
            {`${service.name} (${service.state})${service.required ? "" : " (dependency)"}`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>y start · n cancel</Text>
      </Box>
    </Box>
  );
}

export type { StartServicesBodyProps, StartServicesEntry };
