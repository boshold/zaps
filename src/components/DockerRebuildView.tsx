import { Box, Text } from "ink";

import { useDimensions } from "#src/hooks/useDimensions.js";

import { DockerFlagRow } from "./DockerFlagRow.js";

const DOCKER_REBUILD_FLAGS = [
  { key: "build", label: "--build", description: "Rebuild images" },
  { key: "forceRecreate", label: "--force-recreate", description: "Recreate containers" },
  { key: "renewVolumes", label: "-V", description: "Renew volumes" },
  { key: "pull", label: "--pull always", description: "Pull latest images" },
  { key: "removeOrphans", label: "--remove-orphans", description: "Remove orphan containers" },
] as const;

type DockerFlagKey = (typeof DOCKER_REBUILD_FLAGS)[number]["key"];

interface DockerRebuildPopupProps {
  serviceName: string;
  flags: Record<DockerFlagKey, boolean>;
  flagIndex: number;
}

const POPUP_WIDTH = 52;
const POPUP_HEIGHT = 12;

export function DockerRebuildPopup({ serviceName, flags, flagIndex }: DockerRebuildPopupProps) {
  const { cols: termCols, rows: termHeight } = useDimensions();

  const popupWidth = Math.min(POPUP_WIDTH, Math.max(20, termCols - 2));
  const marginTop = Math.max(0, Math.floor((termHeight - POPUP_HEIGHT) / 2));
  const marginLeft = Math.max(0, Math.floor((termCols - popupWidth) / 2));

  return (
    <Box
      position="absolute"
      marginTop={marginTop}
      marginLeft={marginLeft}
      width={popupWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      backgroundColor="default"
      paddingX={1}
    >
      <Text bold color="cyan">
        Rebuild: {serviceName}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {DOCKER_REBUILD_FLAGS.map((flag, i) => (
          <DockerFlagRow
            key={flag.key}
            active={i === flagIndex}
            checked={flags[flag.key]}
            label={flag.label}
            description={flag.description}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[enter] rebuild [esc] cancel [space] toggle</Text>
      </Box>
    </Box>
  );
}

export type { DockerFlagKey };
export { DOCKER_REBUILD_FLAGS };
