import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { DockerFlagRow } from "../../src/components/DockerFlagRow.js";
import { DOCKER_REBUILD_FLAGS } from "../../src/components/DockerRebuildView.js";

// DockerRebuildPopup uses position="absolute" which ink-testing-library can't capture.
// Test the flag rows and exported constants directly instead.

describe("DOCKER_REBUILD_FLAGS", () => {
  it("has 5 flag definitions", () => {
    expect(DOCKER_REBUILD_FLAGS).toHaveLength(5);
  });

  it("includes expected flag keys", () => {
    const keys = DOCKER_REBUILD_FLAGS.map((f) => f.key);
    expect(keys).toEqual(["build", "forceRecreate", "renewVolumes", "pull", "removeOrphans"]);
  });
});

describe("DockerFlagRow", () => {
  it("shows > indicator when active", () => {
    const { lastFrame } = render(
      <DockerFlagRow active checked={false} label="--build" description="Rebuild images" />,
    );
    expect(lastFrame()).toContain("> ");
  });

  it("does not show > when inactive", () => {
    const { lastFrame } = render(
      <DockerFlagRow active={false} checked={false} label="--build" description="Rebuild images" />,
    );
    expect(lastFrame()).not.toContain("> ");
    expect(lastFrame()).toContain("  ");
  });

  it("shows [x] when checked", () => {
    const { lastFrame } = render(
      <DockerFlagRow active={false} checked label="--build" description="Rebuild images" />,
    );
    expect(lastFrame()).toContain("[x]");
  });

  it("shows [ ] when unchecked", () => {
    const { lastFrame } = render(
      <DockerFlagRow active={false} checked={false} label="--build" description="Rebuild images" />,
    );
    expect(lastFrame()).toContain("[ ]");
  });

  it("renders label and description", () => {
    const { lastFrame } = render(
      <DockerFlagRow
        active={false}
        checked={false}
        label="--force-recreate"
        description="Recreate containers"
      />,
    );
    expect(lastFrame()).toContain("--force-recreate");
    expect(lastFrame()).toContain("Recreate containers");
  });

  it("renders all 5 flags as rows", () => {
    const flags = {
      build: true,
      forceRecreate: false,
      renewVolumes: false,
      pull: false,
      removeOrphans: false,
    };

    const { lastFrame } = render(
      <Box flexDirection="column">
        {DOCKER_REBUILD_FLAGS.map((flag, i) => (
          <DockerFlagRow
            key={flag.key}
            active={i === 0}
            checked={flags[flag.key]}
            label={flag.label}
            description={flag.description}
          />
        ))}
      </Box>,
    );

    const frame = lastFrame();
    expect(frame).toContain("--build");
    expect(frame).toContain("--force-recreate");
    expect(frame).toContain("-V");
    expect(frame).toContain("--pull always");
    expect(frame).toContain("--remove-orphans");
  });
});
