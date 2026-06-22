import { Box } from "ink";
import { render } from "ink-testing-library";
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { DockerFlagRow } from "../../../src/components/DockerFlagRow.js";
import type { DockerFlags } from "../../../src/components/overlay/DockerRebuildOverlay.js";
import {
  DOCKER_REBUILD_FLAGS,
  DOCKER_REBUILD_ID,
  DockerRebuildOverlay,
} from "../../../src/components/overlay/DockerRebuildOverlay.js";
import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import type { OverlayApi } from "../../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";

// DockerRebuildOverlay renders position="absolute" (uncapturable by
// Ink-testing-library), so behavior is asserted via the onConfirm spy + the
// Overlay stack rather than frame text.

const ALL_OFF: DockerFlags = {
  build: false,
  forceRecreate: false,
  renewVolumes: false,
  pull: false,
  removeOrphans: false,
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
};

// Send a key inside act + settle, so the pushed overlay's `useInput`
// Subscription reliably receives it (the mock stdin can otherwise drop the
// First keystroke aimed at a just-mounted listener).
async function press(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

let overlay: OverlayApi | undefined;

function Probe() {
  overlay = useOverlay();
  return null;
}

function DockerHarness({
  onConfirm,
  defaults = ALL_OFF,
}: {
  onConfirm: (name: string, overrides: Record<string, unknown>) => void;
  defaults?: DockerFlags;
}) {
  const api = useOverlay();
  useEffect(() => {
    api.push({
      id: DOCKER_REBUILD_ID,
      render: () => (
        <DockerRebuildOverlay serviceName="web" defaults={defaults} onConfirm={onConfirm} />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only push
  }, []);
  return <OverlayHost />;
}

function renderOverlay(
  onConfirm: (name: string, overrides: Record<string, unknown>) => void,
  defaults?: DockerFlags,
) {
  return render(
    <OverlayProvider>
      <Probe />
      <DockerHarness onConfirm={onConfirm} defaults={defaults} />
    </OverlayProvider>,
  );
}

describe("DockerRebuildOverlay", () => {
  // The overlay ignores any key that isn't k/j/space/enter/arrows, so an initial
  // `x` warms up the mock stdin pipeline without changing state.
  it("confirms with no overrides on Enter and closes", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm);
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, "\r");
    expect(onConfirm).toHaveBeenCalledWith("web", {});
    expect(overlay?.isOpen).toBe(false);
  });

  it("toggles the highlighted flag with Space", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm);
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, " "); // Toggle --build (index 0)
    await press(stdin, "\r");
    expect(onConfirm).toHaveBeenCalledWith("web", { build: true });
  });

  it("moves the selection with j before toggling", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm);
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, "j"); // → --force-recreate (index 1)
    await press(stdin, " ");
    await press(stdin, "\r");
    expect(onConfirm).toHaveBeenCalledWith("web", { forceRecreate: true });
  });

  it("clamps the selection at the top with k", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm);
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, "k"); // Already at top → stays on --build
    await press(stdin, "k");
    await press(stdin, " ");
    await press(stdin, "\r");
    expect(onConfirm).toHaveBeenCalledWith("web", { build: true });
  });

  it("does not bind Esc — OverlayHost closes it without confirming", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm);
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, "\x1B"); // Esc
    expect(onConfirm).not.toHaveBeenCalled();
    expect(overlay?.isOpen).toBe(false);
  });

  it("pre-fills flags from the provided defaults", async () => {
    const onConfirm = vi.fn();
    const { stdin } = renderOverlay(onConfirm, { ...ALL_OFF, build: true });
    await flush();
    await press(stdin, "x"); // Warm-up (ignored)
    await press(stdin, "\r");
    expect(onConfirm).toHaveBeenCalledWith("web", { build: true });
  });
});

describe("DOCKER_REBUILD_FLAGS", () => {
  it("has the 5 expected flag keys in order", () => {
    expect(DOCKER_REBUILD_FLAGS.map((f) => f.key)).toEqual([
      "build",
      "forceRecreate",
      "renewVolumes",
      "pull",
      "removeOrphans",
    ]);
  });
});

describe("DockerFlagRow", () => {
  it("shows the active marker and checked state", () => {
    const { lastFrame } = render(
      <DockerFlagRow active checked label="--build" description="Rebuild images" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("> ");
    expect(frame).toContain("[x]");
    expect(frame).toContain("--build");
    expect(frame).toContain("Rebuild images");
  });

  it("renders all flags as rows in a column", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        {DOCKER_REBUILD_FLAGS.map((flag, i) => (
          <DockerFlagRow
            key={flag.key}
            active={i === 0}
            checked={false}
            label={flag.label}
            description={flag.description}
          />
        ))}
      </Box>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("--force-recreate");
    expect(frame).toContain("--remove-orphans");
  });
});
