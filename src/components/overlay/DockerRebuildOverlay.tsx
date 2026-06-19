import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { DockerFlagRow } from "#src/components/DockerFlagRow.js";
import type { DockerConfig } from "#src/config/types.js";
import { useDimensions } from "#src/hooks/useDimensions.js";
import { useOverlay } from "#src/hooks/useOverlay.js";

/** Overlay id — shared with the Router so it pushes/gates the same descriptor. */
const DOCKER_REBUILD_ID = "docker-rebuild";

const DOCKER_REBUILD_FLAGS = [
  { key: "build", label: "--build", description: "Rebuild images" },
  { key: "forceRecreate", label: "--force-recreate", description: "Recreate containers" },
  { key: "renewVolumes", label: "-V", description: "Renew volumes" },
  { key: "pull", label: "--pull always", description: "Pull latest images" },
  { key: "removeOrphans", label: "--remove-orphans", description: "Remove orphan containers" },
] as const;

type DockerFlagKey = (typeof DOCKER_REBUILD_FLAGS)[number]["key"];
type DockerFlags = Record<DockerFlagKey, boolean>;

const POPUP_WIDTH = 52;
const POPUP_HEIGHT = 12;

/** Translate the toggle state into the compose override flags the daemon expects. */
function buildDockerOverrides(flags: DockerFlags): Partial<DockerConfig> {
  const overrides: Partial<DockerConfig> = {};
  if (flags.build) {
    overrides.build = true;
  }
  if (flags.forceRecreate) {
    overrides.forceRecreate = true;
  }
  if (flags.renewVolumes) {
    overrides.renewVolumes = true;
  }
  if (flags.pull) {
    overrides.pull = "always";
  }
  if (flags.removeOrphans) {
    overrides.removeOrphans = true;
  }
  return overrides;
}

interface DockerRebuildOverlayProps {
  serviceName: string;
  /** Initial flag state, pre-filled from the service's `dockerDefaults`. */
  defaults: DockerFlags;
  /** Confirm handler — runs `services.rebuild` (with its own busy guard) in the Router. */
  onConfirm: (name: string, overrides: Partial<DockerConfig>) => void;
}

/**
 * Docker-rebuild flag picker, hosted on the overlay stack. It owns its own flag
 * state + input (gated on `isTop`): `Space` toggles, `↑↓`/`kj` move, `Enter`
 * confirms (→ `onConfirm` + close). It does NOT bind Esc — `OverlayHost` owns
 * Esc→pop, which cancels without rebuilding.
 */
function DockerRebuildOverlay({ serviceName, defaults, onConfirm }: DockerRebuildOverlayProps) {
  const { cols, rows } = useDimensions();
  const { isTop, pop } = useOverlay();
  const [flags, setFlags] = useState<DockerFlags>(defaults);
  const [flagIndex, setFlagIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        setFlagIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setFlagIndex((i) => Math.min(DOCKER_REBUILD_FLAGS.length - 1, i + 1));
        return;
      }
      if (input === " ") {
        const flagKey = DOCKER_REBUILD_FLAGS[flagIndex].key;
        setFlags((prev) => ({ ...prev, [flagKey]: !prev[flagKey] }));
        return;
      }
      if (key.return) {
        onConfirm(serviceName, buildDockerOverrides(flags));
        pop();
      }
    },
    { isActive: isTop(DOCKER_REBUILD_ID) },
  );

  const popupWidth = Math.min(POPUP_WIDTH, Math.max(20, cols - 2));
  const marginTop = Math.max(0, Math.floor((rows - POPUP_HEIGHT) / 2));
  const marginLeft = Math.max(0, Math.floor((cols - popupWidth) / 2));

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

export { DOCKER_REBUILD_FLAGS, DOCKER_REBUILD_ID, DockerRebuildOverlay };
export type { DockerFlagKey, DockerFlags };
