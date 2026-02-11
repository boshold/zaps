import type { ServiceStatus } from "#src/lib/service/types.js";
import { Box } from "ink";

import { ServiceRow } from "./ServiceRow.js";

interface ServiceListProps {
  statuses: ServiceStatus[];
  selectedIndex: number;
}

export function ServiceList({ statuses, selectedIndex }: ServiceListProps) {
  return (
    <Box flexDirection="column">
      {statuses.map((s, i) => (
        <ServiceRow key={s.name} status={s} isSelected={i === selectedIndex} />
      ))}
    </Box>
  );
}
