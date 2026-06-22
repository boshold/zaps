import { Box, Text } from "ink";

import type { ServiceStatus } from "#src/lib/service/types.js";

import { buildRule } from "./dashboardRule.js";
import { HeaderRow } from "./HeaderRow.js";
import { useIcons } from "./theme/IconTheme.js";

interface HeaderProps {
  projectName: string;
  statuses: ServiceStatus[];
  width: number;
  compact?: boolean;
  configStale?: boolean;
  /** Column of the pane divider; when set, the rule gets a `┬` junction there. */
  dividerCol?: number;
}

export function Header({
  projectName,
  statuses,
  width,
  compact,
  configStale,
  dividerCol,
}: HeaderProps) {
  const { icon } = useIcons();
  const junction =
    dividerCol === undefined ? undefined : { char: icon("dividerTop"), col: dividerCol };
  return (
    <Box flexDirection="column">
      <HeaderRow projectName={projectName} statuses={statuses} configStale={configStale} />
      {!compact && <Text color="gray">{buildRule(width, icon("divider"), junction)}</Text>}
    </Box>
  );
}
